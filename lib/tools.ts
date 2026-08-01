import type { Credentials } from "./credentials";
import { callTool, listTools } from "./mcp";
import { saveMemory, searchMemories } from "./memory";
import { savePrefs } from "./prefs";
import type { ToolDef } from "./providers/llm";
import { redact } from "./redact";

/**
 * The assistant's capabilities.
 *
 * Two sources, deliberately separate:
 *
 *   1. Local tools (memory, preferred name) — ours, no network, always present.
 *   2. Everything else — discovered from the *user's own* Composio MCP
 *      endpoint. We never enumerate a shared catalogue, so there is no way to
 *      address another tenant's integrations: we don't hold their endpoint.
 */

const LOCAL_TOOLS: ToolDef[] = [
  {
    name: "set_preferred_name",
    description:
      'Set what to call the user. Call this the moment they say what they want to be called — "call me Thomas", "it\'s Dr Foley", "stop calling me sir". Persists across sessions.',
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Exactly what to call them, e.g. "Thomas". Empty string means use no name at all.',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "remember_fact",
    description:
      "Store a durable fact, preference, or decision about the user for future conversations. Only for things worth keeping.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "A standalone sentence in the third person." },
      },
      required: ["fact"],
    },
  },
  {
    name: "recall_facts",
    description: "Search previously stored facts about the user.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for." } },
      required: ["query"],
    },
  },
];

const LOCAL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

/**
 * A Composio account with many apps connected can expose hundreds of tools.
 * Sending them all would dominate the prompt and slow every turn, so we cap —
 * and report the cap rather than silently truncating.
 */
const MAX_REMOTE_TOOLS = 48;

export type Catalogue = {
  tools: ToolDef[];
  remoteCount: number;
  truncated: boolean;
  note: string;
};

export async function buildCatalogue(
  creds: Credentials,
  signal?: AbortSignal,
): Promise<Catalogue> {
  if (!creds.mcpUrl || !creds.composioKey) {
    return {
      tools: [...LOCAL_TOOLS],
      remoteCount: 0,
      truncated: false,
      note: "No MCP endpoint connected, so only memory tools are available.",
    };
  }

  const res = await listTools(creds.mcpUrl, creds.composioKey, signal);
  if (!res.ok) {
    return {
      tools: [...LOCAL_TOOLS],
      remoteCount: 0,
      truncated: false,
      note: `MCP unavailable: ${res.error}`,
    };
  }

  const remote = res.data
    // Never let a remote tool shadow a local one.
    .filter((t) => !LOCAL_NAMES.has(t.name))
    .slice(0, MAX_REMOTE_TOOLS)
    .map<ToolDef>((t) => ({
      name: t.name,
      description: t.description || t.name,
      input_schema: {
        type: "object",
        properties: t.inputSchema?.properties ?? {},
        ...(Array.isArray(t.inputSchema?.required) ? { required: t.inputSchema.required } : {}),
      },
    }));

  return {
    tools: [...remote, ...LOCAL_TOOLS],
    remoteCount: res.data.length,
    truncated: res.data.length > MAX_REMOTE_TOOLS,
    note:
      res.data.length > MAX_REMOTE_TOOLS
        ? `Showing ${MAX_REMOTE_TOOLS} of ${res.data.length} tools from your MCP endpoint.`
        : "",
  };
}

/** Present-tense label shown in the UI while a tool runs. */
export function toolLabel(name: string): string {
  const local: Record<string, string> = {
    remember_fact: "Committing that to memory",
    recall_facts: "Recalling",
    set_preferred_name: "Noted",
  };
  if (local[name]) return local[name];

  // Derive something readable from an MCP slug: GMAIL_FETCH_EMAILS -> "Gmail".
  const app = name.split(/[_.]/)[0];
  if (!app) return "Working";
  return `Checking ${app.charAt(0).toUpperCase()}${app.slice(1).toLowerCase()}`;
}

export type ToolContext = {
  tz: string;
  email: string;
  creds: Credentials;
  signal?: AbortSignal;
};

export async function runTool(
  name: string,
  input: Record<string, any>,
  ctx: ToolContext,
): Promise<string> {
  try {
    switch (name) {
      case "set_preferred_name": {
        const next = String(input.name ?? "").trim().slice(0, 40);
        await savePrefs(ctx.email, { userName: next });
        // Confirm in-band: this turn's system prompt still carries the old
        // name, so the model has to be told explicitly.
        return next
          ? `Saved. Address them as "${next}" from now on, starting with your next reply.`
          : "Saved. Use no form of address from now on.";
      }

      case "remember_fact":
        return (await saveMemory(ctx.email, String(input.fact ?? "")))
          ? "Saved."
          : "Nothing to save.";

      case "recall_facts": {
        const hits = await searchMemories(ctx.email, String(input.query ?? ""));
        return hits.length ? hits.join("\n") : "No stored facts match that.";
      }

      default: {
        if (!ctx.creds.mcpUrl || !ctx.creds.composioKey) {
          return "That needs an MCP endpoint, which isn't connected yet.";
        }
        const res = await callTool(
          ctx.creds.mcpUrl,
          ctx.creds.composioKey,
          name,
          input ?? {},
          ctx.signal,
        );
        return res.ok ? condense(res.data) : `That failed: ${res.error}`;
      }
    }
  } catch (e) {
    return `Tool error: ${redact(e).slice(0, 200)}`;
  }
}

/**
 * Tool output goes straight into the model's context, so it has to be small.
 * A raw Gmail payload is tens of kilobytes of quoted HTML — slow, and actively
 * harmful to answer quality.
 */
export function condense(text: string, maxLen = 3000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…\n[truncated — say "read it out" for more]`;
}
