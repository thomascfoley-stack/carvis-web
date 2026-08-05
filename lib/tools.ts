import type { Credentials } from "./credentials";
import { defineNode } from "./graph";
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

/* ------------------------------ local tools ---------------------------- */

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

/**
 * Tool catalogues barely change, but without a cache every single chat turn
 * pays a full MCP round trip (initialize + tools/list on cold instances)
 * before the model can even start thinking. Five minutes of staleness against
 * seconds off time-to-first-token is not a close call. Keyed by endpoint, so
 * changing your MCP URL in Setup bypasses it immediately.
 */
const CATALOGUE_TTL_MS = 5 * 60_000;
const catalogueCache = new Map<string, { at: number; cat: Catalogue }>();

/**
 * Keyed by user AND endpoint.
 *
 * The endpoint alone is not a tenant boundary: every OAuth user pastes the
 * same connect.composio.dev URL, and on that path the chat route deliberately
 * does NOT append user_id — so a URL-keyed cache served one person's tool list
 * to everyone else on the instance. Tools are not secret in themselves, but
 * the list names which apps someone has connected, and the model would offer
 * to call integrations the caller does not have.
 */
const catalogueKey = (email: string, mcpUrl: string) => `${email.toLowerCase()}\u0000${mcpUrl}`;

export function forgetCatalogue(email: string, mcpUrl: string): void {
  catalogueCache.delete(catalogueKey(email, mcpUrl));
}

export async function buildCatalogue(
  creds: Credentials,
  email: string,
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

  const key = catalogueKey(email, creds.mcpUrl);
  const hit = catalogueCache.get(key);
  if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.cat;

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

  const cat: Catalogue = {
    tools: [...remote, ...LOCAL_TOOLS],
    remoteCount: res.data.length,
    truncated: res.data.length > MAX_REMOTE_TOOLS,
    note:
      res.data.length > MAX_REMOTE_TOOLS
        ? `Showing ${MAX_REMOTE_TOOLS} of ${res.data.length} tools from your MCP endpoint.`
        : "",
  };
  catalogueCache.set(key, { at: Date.now(), cat });
  if (catalogueCache.size > 2000) catalogueCache.clear();
  return cat;
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

async function runToolBody(
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
        // Composio's meta-tools (search → execute) return the model's working
        // map — schemas and row data. Truncating those to chat size made the
        // model count five of forty-nine opportunities and invent the rest.
        const budget = /^COMPOSIO_/i.test(name) ? 14000 : 3000;
        return res.ok ? condense(res.data, budget) : `That failed: ${res.error}`;
      }
    }
  } catch (e) {
    return `Tool error: ${redact(e).slice(0, 200)}`;
  }
}

/**
 * Tool arguments are the user's own prose — a drafted email body, a memory —
 * and the failures table is cross-tenant. The reproduction therefore records
 * the *shape* of every argument, never its value: which keys, which types,
 * what sizes. That reproduces schema and payload-size defects, which is what
 * tool failures actually are, without archiving anyone's words.
 */
function argShapes(input: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {})
      .slice(0, 20)
      .map(([k, v]) => [
        k,
        typeof v === "string"
          ? `string(${v.length})`
          : Array.isArray(v)
            ? `array(${v.length})`
            : v === null
              ? "null"
              : typeof v,
      ]),
  );
}

/**
 * A failed tool answers with a sentence rather than throwing — the model needs
 * something to read — so failure here is a soft check on the output. "That
 * needs an MCP endpoint" is deliberately absent: no endpoint connected is the
 * user's configuration, not a defect.
 */
const toolNode = defineNode<
  { name: string; input: Record<string, any>; ctx: ToolContext },
  string
>({
  id: (a) => `tool.${a.name.slice(0, 64)}`,
  run: (a) => runToolBody(a.name, a.input, a.ctx),
  soft: (out) =>
    /^(That failed|Tool error)/.test(out)
      ? { class: "ToolFailed", message: out.slice(0, 500) }
      : null,
  sample: (a) => argShapes(a.input),
});

export const runTool = (
  name: string,
  input: Record<string, any>,
  ctx: ToolContext,
): Promise<string> => toolNode({ name, input, ctx }, { signal: ctx.signal });

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
