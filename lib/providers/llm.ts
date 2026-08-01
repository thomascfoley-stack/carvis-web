import type { LlmSettings } from "../store";

import { redact } from "../redact";

/**
 * Provider-agnostic LLM layer.
 *
 * Practically every hosted model speaks one of two wire formats: Anthropic
 * Messages or OpenAI Chat Completions. So rather than integrate N providers we
 * implement those two once and treat each provider as configuration. Adding an
 * eleventh provider is a registry entry, not code.
 */

export type LlmFormat = "anthropic" | "openai";

export type LlmProvider = {
  id: string;
  label: string;
  format: LlmFormat;
  baseUrl: string;
  models: string[];
  keyUrl: string;
  /** Set when the endpoint is user-supplied (custom / self-hosted). */
  editableBaseUrl?: boolean;
  note?: string;
};

/** Order matters: the first entry is the default shown to a new user. */
export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    format: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
    keyUrl: "https://console.anthropic.com",
    note: "Haiku 4.5 is the latency pick; Sonnet 5 for harder reasoning.",
  },
  {
    id: "openai",
    label: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "groq",
    label: "Groq",
    format: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyUrl: "https://console.groq.com/keys",
    note: "Fastest tokens-per-second available. Excellent for voice.",
  },
  {
    id: "google",
    label: "Google Gemini",
    format: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.0-flash", "gemini-2.5-flash"],
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Uses Gemini's OpenAI-compatible endpoint.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    format: "openai",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat"],
    keyUrl: "https://platform.deepseek.com",
  },
  {
    id: "xai",
    label: "xAI Grok",
    format: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-2-latest"],
    keyUrl: "https://console.x.ai",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-haiku-4.5", "google/gemini-2.0-flash-001"],
    keyUrl: "https://openrouter.ai/keys",
    note: "One key, hundreds of models.",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    format: "anthropic",
    baseUrl: "https://api.moonshot.ai/anthropic",
    models: ["kimi-k2.7-code-highspeed", "kimi-k2.5", "kimi-k3[1m]"],
    keyUrl: "https://platform.moonshot.ai",
    note: "Cheap and fast. What the upstream macOS CARVIS was tuned for.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    format: "openai",
    baseUrl: "",
    models: [],
    keyUrl: "",
    editableBaseUrl: true,
    note: "Any OpenAI-compatible endpoint — Together, Fireworks, Ollama, vLLM, LM Studio.",
  },
  {
    id: "custom-anthropic",
    label: "Custom (Anthropic-compatible)",
    format: "anthropic",
    baseUrl: "",
    models: [],
    keyUrl: "",
    editableBaseUrl: true,
  },
];

export function findProvider(id: string): LlmProvider {
  return LLM_PROVIDERS.find((p) => p.id === id) ?? LLM_PROVIDERS[0];
}

/* ------------------------------------------------------------------ *
 * Canonical message shape
 *
 * The two wire formats disagree about how tool calls and tool results are
 * represented, so the rest of the app speaks this and we translate at the edge.
 * ------------------------------------------------------------------ */

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type CanonMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string }[] };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "error"; message: string };

/* ---------------------------- translation ---------------------------- */

function toAnthropic(msgs: CanonMsg[]) {
  return msgs.map((m) => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      return { role: "assistant", content: content.length ? content : [{ type: "text", text: " " }] };
    }
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
      })),
    };
  });
}

function toOpenAI(msgs: CanonMsg[], system: string) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const entry: any = { role: "assistant", content: m.text || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      out.push(entry);
    } else {
      for (const r of m.results) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

/* ------------------------------ streaming ---------------------------- */

/** Yields decoded SSE `data:` payloads from a byte stream. */
async function* sseFrames(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const raw of frame.split("\n")) {
          if (!raw.startsWith("data:")) continue;
          const payload = raw.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload);
          } catch {
            /* keepalive or partial frame */
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

export async function* streamLLM(args: {
  settings: LlmSettings;
  system: string;
  messages: CanonMsg[];
  tools: ToolDef[];
  signal?: AbortSignal;
  maxTokens?: number;
}): AsyncGenerator<StreamEvent> {
  const provider = findProvider(args.settings.providerId);
  const base = (args.settings.baseUrl || provider.baseUrl || "").replace(/\/+$/, "");
  const key = args.settings.apiKey ?? "";
  const model = args.settings.model || provider.models[0] || "";

  if (!base) {
    yield { type: "error", message: "No API base URL configured for this provider." };
    return;
  }
  if (!key) {
    yield { type: "error", message: "No API key configured. Add one in Settings." };
    return;
  }

  const anthropic = provider.format === "anthropic";

  const url = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["authorization"] = `Bearer ${key}`;
  } else {
    headers["authorization"] = `Bearer ${key}`;
  }

  const body = anthropic
    ? {
        model,
        max_tokens: args.maxTokens ?? 1024,
        system: args.system,
        messages: toAnthropic(args.messages),
        tools: args.tools,
        stream: true,
      }
    : {
        model,
        max_tokens: args.maxTokens ?? 1024,
        messages: toOpenAI(args.messages, args.system),
        tools: args.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        stream: true,
      };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (e) {
    yield { type: "error", message: `Could not reach ${provider.label}: ${redact(e).slice(0, 160)}` };
    return;
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    yield {
      type: "error",
      message: `${provider.label} returned ${res.status}. ${redact(detail).slice(0, 240)}`,
    };
    return;
  }

  if (anthropic) {
    const blocks: Record<number, any> = {};
    const partial: Record<number, string> = {};

    for await (const ev of sseFrames(res.body, args.signal)) {
      switch (ev.type) {
        case "content_block_start": {
          const cb = ev.content_block ?? {};
          blocks[ev.index] =
            cb.type === "tool_use"
              ? { id: cb.id, name: cb.name, input: {} }
              : { text: true };
          if (cb.type === "tool_use") partial[ev.index] = "";
          break;
        }
        case "content_block_delta": {
          const d = ev.delta ?? {};
          if (d.type === "text_delta" && d.text) {
            yield { type: "text", text: d.text };
          } else if (d.type === "input_json_delta") {
            partial[ev.index] = (partial[ev.index] ?? "") + (d.partial_json ?? "");
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks[ev.index];
          if (b && b.id) {
            try {
              b.input = partial[ev.index] ? JSON.parse(partial[ev.index]) : {};
            } catch {
              b.input = {};
            }
          }
          break;
        }
        case "error":
          yield { type: "error", message: String(ev.error?.message ?? "stream error") };
          break;
      }
    }

    const calls = Object.values(blocks)
      .filter((b: any) => b?.id)
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    if (calls.length) yield { type: "tool_calls", calls };
    return;
  }

  // OpenAI Chat Completions
  const acc: Record<number, { id: string; name: string; args: string }> = {};

  for await (const ev of sseFrames(res.body, args.signal)) {
    const delta = ev.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) yield { type: "text", text: delta.content };

    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      if (!acc[i]) acc[i] = { id: tc.id ?? `call_${i}`, name: "", args: "" };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function?.name) acc[i].name += tc.function.name;
      if (tc.function?.arguments) acc[i].args += tc.function.arguments;
    }
  }

  const calls = Object.values(acc)
    .filter((c) => c.name)
    .map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = {};
      }
      return { id: c.id, name: c.name, input };
    });

  if (calls.length) yield { type: "tool_calls", calls };
}
