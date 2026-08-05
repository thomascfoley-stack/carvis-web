import { createHash } from "node:crypto";

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

/**
 * Exactly ONE auth header per request. Composio's backend rejects a request
 * carrying both `authorization: Bearer` and `x-api-key` ("Multiple
 * authentication modes were provided") — sending both to be safe is precisely
 * the thing that breaks it. An API-key-shaped credential goes in x-api-key,
 * a JWT-shaped one in the Bearer header; a 401 flips the guess once and the
 * winner is remembered per endpoint.
 */
type AuthMode = "x-api-key" | "bearer";

const guessAuthMode = (apiKey: string): AuthMode =>
  /^eyJ/.test(apiKey) ? "bearer" : "x-api-key";

const flip = (m: AuthMode): AuthMode => (m === "bearer" ? "x-api-key" : "bearer");

type Session = { id: string; initialised: boolean; authMode?: AuthMode };

/**
 * (Endpoint + credential) -> session.
 *
 * Keying on the URL alone leaked across tenants. Every OAuth user pastes the
 * SAME endpoint (connect.composio.dev/mcp) and is told apart only by their
 * bearer token, so one user's mcp-session-id was attached to every other
 * user's requests to that host — a session handle minted under someone else's
 * identity. The credential is hashed, never stored: this map is a cache key,
 * not a credential store, and a heap dump of it must reveal nothing.
 */
const sessions = new Map<string, Session>();

const fingerprint = (apiKey: string): string =>
  apiKey ? createHash("sha256").update(apiKey).digest("base64url").slice(0, 22) : "anon";

/** The identity under which a session may be reused: endpoint AND caller. */
const sessionKey = (url: string, apiKey: string): string => `${url}\u0000${fingerprint(apiKey)}`;

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

  const key = sessionKey(url, apiKey);
  const session = sessions.get(key);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Servers pick their response shape from this; we accept both.
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (apiKey) {
    const mode = session?.authMode ?? guessAuthMode(apiKey);
    if (mode === "bearer") headers.authorization = `Bearer ${apiKey}`;
    else headers["x-api-key"] = apiKey;
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
  if (sid) sessions.set(key, { id: sid, initialised: session?.initialised ?? false, authMode: session?.authMode });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (looksLikeDeadSession(res.status, detail)) {
      sessions.delete(key);
      return { ok: false, error: `MCP ${res.status}: session expired`, retryable: true };
    }
    // Composio's *portal* endpoint (connect.composio.dev) only accepts OAuth
    // sign-in, never an API key. Name the actual mistake instead of "401".
    if (res.status === 401 && /AuthKit JWT/i.test(detail)) {
      return {
        ok: false,
        error:
          "That URL is Composio's sign-in portal, which an API key can never open. Use an MCP server URL from your Composio dashboard instead.",
      };
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
 * Run an MCP call, re-handshaking if the server has dropped our session.
 *
 * Without this, a single expiry poisons the module-level session cache: every
 * later request on that warm instance fails, and it presents as "integrations
 * stopped working" with nothing in the logs to explain why.
 *
 * Three attempts, not two: under a concurrent burst, one caller's recovery
 * can interleave with another's map delete, so a freshly handshaken caller
 * may still fire one request with no session id. The extra attempt absorbs
 * that window; genuine outages still fail fast because ensureInitialised
 * itself errors.
 */
async function withSession<T>(
  url: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  attempt: () => Promise<McpResult<T>>,
): Promise<McpResult<T>> {
  let last: McpResult<T> = { ok: false, error: "MCP call never ran." };
  for (let tries = 0; tries < 3; tries++) {
    const init = await ensureInitialised(url, apiKey, signal);
    if (!init.ok) return init;

    last = await attempt();
    if (last.ok || !last.retryable) return last;
    sessions.delete(sessionKey(url, apiKey));
  }
  return last;
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

/**
 * Concurrent callers coalesce onto one handshake. Without this, a burst of
 * calls after an expiry races eight initializes whose map writes interleave
 * with each other's deletes — and a caller can end up "initialised" with an
 * empty session id.
 */
const inflightInit = new Map<string, Promise<McpResult<true>>>();

/** MCP requires an initialize handshake before any other call. */
function ensureInitialised(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<McpResult<true>> {
  const key = sessionKey(url, apiKey);
  if (sessions.get(key)?.initialised) return Promise.resolve({ ok: true, data: true });

  const pending = inflightInit.get(key);
  if (pending) return pending;

  const job = (async (): Promise<McpResult<true>> => {
    const init = () =>
      rpc(
        url,
        apiKey,
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "carvis-web", version: "1.0.0" },
        },
        signal,
      );

    let res = await init();

    // A 401 on the handshake may only mean the auth-mode guess was wrong —
    // flip it and try once more. If that also fails, the key itself is the
    // problem, and the first error names it under the more likely mode.
    if (!res.ok && apiKey && res.error.startsWith("MCP 401")) {
      const prior = sessions.get(key);
      sessions.set(key, {
        id: "",
        initialised: false,
        authMode: flip(prior?.authMode ?? guessAuthMode(apiKey)),
      });
      const retry = await init();
      if (!retry.ok) {
        sessions.delete(key);
        return res;
      }
      res = retry;
    }
    if (!res.ok) return res;

    const existing = sessions.get(key);
    sessions.set(key, {
      id: existing?.id ?? "",
      initialised: true,
      authMode: existing?.authMode,
    });

    // The spec requires this before any other request, so await it rather
    // than racing it against tools/list — a strict server rejects the request
    // that wins that race.
    await rpc(url, apiKey, "notifications/initialized", {}, signal, true).catch(() => undefined);

    return { ok: true, data: true };
  })();

  inflightInit.set(key, job);
  return job.finally(() => inflightInit.delete(key));
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
  // The credential may have changed too, so drop every session for this
  // endpoint rather than guessing which key the caller now holds.
  for (const k of [...sessions.keys()]) {
    if (k.startsWith(`${url}\u0000`)) sessions.delete(k);
  }
}

/**
 * Composio MCP servers refuse requests without a `user_id` query parameter
 * ("required for security reasons"), and the session already knows the
 * caller's Composio id — so the app appends it rather than asking people to
 * hand-assemble URLs. Only touches composio.dev hosts, and never overrides
 * an id the URL already carries.
 */
export function withUserId(url: string, cid: string): string {
  if (!url || !cid) return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)composio\.dev$/i.test(u.hostname)) return url;
    if (u.searchParams.has("user_id") || u.searchParams.has("connected_account_id")) return url;
    u.searchParams.set("user_id", cid);
    return u.toString();
  } catch {
    return url;
  }
}
