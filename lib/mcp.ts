import { redact } from "./redact";

/**
 * Minimal MCP client (Streamable HTTP transport).
 *
 * Integrations no longer go through Composio's REST tools API with a shared
 * key. Each user has their own Composio MCP endpoint, and everything the
 * assistant can reach comes from *that* endpoint's tool list. Tenant isolation
 * is therefore structural rather than a parameter we must remember to pass:
 * there is no way to address another user's tools, because we never hold their
 * endpoint.
 *
 * MCP is JSON-RPC 2.0. A server may answer with plain JSON or an SSE stream,
 * so both are handled.
 */

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type McpResult<T> = { ok: true; data: T } | { ok: false; error: string; retryable?: boolean };

const PROTOCOL_VERSION = "2025-06-18";

type Session = { id: string; initialised: boolean };

/** Endpoint -> session. MCP servers may hand back a session id to reuse. */
const sessions = new Map<string, Session>();

let nextId = 1;

/**
 * Does this look like the server having forgotten our session rather than a
 * genuine failure? Streamable HTTP answers a dead session id with 404 (and
 * sometimes 400), which otherwise turns one expiry into every subsequent call
 * failing for the lifetime of a warm serverless instance.
 */
function looksLikeDeadSession(status: number, detail: string): boolean {
  if (status === 404) return true;
  return (status === 400 || status === 401) && /session/i.test(detail);
}

async function rpc(
  url: string,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  isNotification = false,
): Promise<McpResult<any>> {
  if (!url) return { ok: false, error: "No MCP endpoint configured." };

  const session = sessions.get(url);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Servers pick their response shape from this; we accept both.
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }
  if (session?.id) headers["mcp-session-id"] = session.id;

  // JSON-RPC notifications carry no id. Sending one makes it a request, which
  // a strict server answers with an error.
  const payload = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: nextId++, method, params };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `Could not reach your MCP endpoint: ${redact(e).slice(0, 160)}` };
  }

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessions.set(url, { id: sid, initialised: session?.initialised ?? false });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (looksLikeDeadSession(res.status, detail)) {
      sessions.delete(url);
      return { ok: false, error: `MCP ${res.status}: session expired`, retryable: true };
    }
    return { ok: false, error: `MCP ${res.status}: ${redact(detail).slice(0, 200)}` };
  }

  // A notification is acknowledged with 202 and an empty body.
  if (isNotification || res.status === 202) return { ok: true, data: null };

  const body = await readBody(res);
  if (!body) return { ok: false, error: "MCP returned an empty response." };
  if (body.error) {
    return { ok: false, error: redact(body.error.message ?? "MCP error").slice(0, 250) };
  }
  return { ok: true, data: body.result };
}

/**
 * Run an MCP call, re-handshaking once if the server has dropped our session.
 *
 * Without this, a single expiry poisons the module-level session cache: every
 * later request on that warm instance fails, and it presents as "integrations
 * stopped working" with nothing in the logs to explain why.
 */
async function withSession<T>(
  url: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  attempt: () => Promise<McpResult<T>>,
): Promise<McpResult<T>> {
  const init = await ensureInitialised(url, apiKey, signal);
  if (!init.ok) return init;

  const first = await attempt();
  if (first.ok || !first.retryable) return first;

  sessions.delete(url);
  const again = await ensureInitialised(url, apiKey, signal);
  if (!again.ok) return again;
  return attempt();
}

/** Handles both a plain JSON reply and an SSE stream carrying one. */
async function readBody(res: Response): Promise<any | null> {
  const type = res.headers.get("content-type") ?? "";

  if (!type.includes("text/event-stream")) {
    return res.json().catch(() => null);
  }

  const text = await res.text().catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload);
      // Skip notifications; we want the response carrying a result or error.
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    } catch {
      /* keepalive frame */
    }
  }
  return null;
}

/** MCP requires an initialize handshake before any other call. */
async function ensureInitialised(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<McpResult<true>> {
  if (sessions.get(url)?.initialised) return { ok: true, data: true };

  const res = await rpc(
    url,
    apiKey,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jarvis-web", version: "1.0.0" },
    },
    signal,
  );
  if (!res.ok) return res;

  const existing = sessions.get(url);
  sessions.set(url, { id: existing?.id ?? "", initialised: true });

  // The spec requires this before any other request, so await it rather than
  // racing it against tools/list — a strict server rejects the request that
  // wins that race.
  await rpc(url, apiKey, "notifications/initialized", {}, signal, true).catch(() => undefined);

  return { ok: true, data: true };
}

export async function listTools(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<McpResult<McpTool[]>> {
  const res = await withSession(url, apiKey, signal, () =>
    rpc(url, apiKey, "tools/list", {}, signal),
  );
  if (!res.ok) return res;

  const raw = Array.isArray(res.data?.tools) ? res.data.tools : [];
  const tools: McpTool[] = raw
    .filter((t: any) => typeof t?.name === "string")
    .map((t: any) => ({
      name: t.name,
      description: String(t.description ?? "").slice(0, 400),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} },
    }));

  return { ok: true, data: tools };
}

export async function callTool(
  url: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpResult<string>> {
  const res = await withSession(url, apiKey, signal, () =>
    rpc(url, apiKey, "tools/call", { name, arguments: args }, signal),
  );
  if (!res.ok) return res;

  // MCP returns content blocks; flatten to text for the model.
  const content = Array.isArray(res.data?.content) ? res.data.content : [];
  const text = content
    .map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
    .join("\n")
    .trim();

  if (res.data?.isError) {
    return { ok: false, error: redact(text || "The tool reported an error.").slice(0, 300) };
  }
  return { ok: true, data: text || "Done." };
}

/** Drop cached handshake state, e.g. after the user changes their endpoint. */
export function forgetSession(url: string): void {
  sessions.delete(url);
}
