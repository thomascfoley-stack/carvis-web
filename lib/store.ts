/**
 * Server-side settings store.
 *
 * Runtime-configurable provider settings need somewhere to live that survives
 * a lambda recycling, so this uses Redis-over-HTTP (Vercel KV / Upstash) when
 * configured. Without it the app still runs entirely from environment
 * variables — you just can't change providers from the UI.
 *
 * API keys written here are NEVER returned to the browser. See maskSettings().
 */

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

export const kvEnabled = () => !!(KV_URL && KV_TOKEN);

export async function redis(command: unknown[]): Promise<any> {
  if (!kvEnabled()) throw new Error("KV not configured");
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  return (await res.json())?.result;
}

export type LlmSettings = {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
};

export type TtsSettings = {
  providerId: string;
  voiceId: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

export type Prefs = {
  userName: string;
  /** How much detail JARVIS volunteers before you ask for more. */
  verbosity: "terse" | "balanced" | "detailed";
  autoListen: boolean;
  bargeIn: boolean;
};

export type Settings = {
  llm: LlmSettings;
  tts: TtsSettings;
  prefs: Prefs;
};

const KEY = "jarvis:settings:v1";

function envDefaults(): Settings {
  const env = (...names: string[]) => {
    for (const n of names) {
      const v = process.env[n];
      if (v && v.trim()) return v.trim();
    }
    return "";
  };

  // Defaults are Anthropic for reasoning and OpenAI for voice — the two most
  // widely trusted vendors. Every other provider stays one dropdown away.
  const ttsProvider =
    env("JARVIS_TTS_PROVIDER") ||
    (env("OPENAI_API_KEY") ? "openai" : env("FISH_API_KEY") ? "fish" : "openai");

  const preferMoonshot = !!env("MOONSHOT_API_KEY") && !env("ANTHROPIC_API_KEY");

  return {
    llm: {
      providerId: env("JARVIS_LLM_PROVIDER") || (preferMoonshot ? "moonshot" : "anthropic"),
      model:
        env("JARVIS_FAST_MODEL") ||
        (preferMoonshot ? "kimi-k2.7-code-highspeed" : "claude-haiku-4-5-20251001"),
      baseUrl: env("JARVIS_BASE_URL", "ANTHROPIC_BASE_URL"),
      apiKey: env("JARVIS_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "MOONSHOT_API_KEY"),
    },
    tts: {
      providerId: ttsProvider,
      voiceId:
        env("JARVIS_TTS_VOICE") ||
        (ttsProvider === "fish" ? "612b878b113047d9a770c069c8b4fdfe" : "onyx"),
      model:
        env("JARVIS_TTS_MODEL") || (ttsProvider === "fish" ? "speech-1.6" : "gpt-4o-mini-tts"),
      apiKey: ttsProvider === "fish" ? env("FISH_API_KEY") : env("OPENAI_API_KEY", "FISH_API_KEY"),
    },
    prefs: {
      userName: env("USER_NAME") || "sir",
      verbosity: "balanced",
      autoListen: true,
      bargeIn: true,
    },
  };
}

/** In-process cache so a hot lambda doesn't hit KV on every token stream. */
let cache: { at: number; value: Settings } | null = null;
const TTL_MS = 5000;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const defaults = envDefaults();
  if (!kvEnabled()) {
    cache = { at: Date.now(), value: defaults };
    return defaults;
  }

  try {
    const raw = await redis(["GET", KEY]);
    const stored = raw ? (JSON.parse(String(raw)) as Partial<Settings>) : {};
    const merged: Settings = {
      // Stored values win, but fall back per-field so a half-filled record
      // never wipes out a working env-var config.
      llm: { ...defaults.llm, ...(stored.llm ?? {}) },
      tts: { ...defaults.tts, ...(stored.tts ?? {}) },
      prefs: { ...defaults.prefs, ...(stored.prefs ?? {}) },
    };
    cache = { at: Date.now(), value: merged };
    return merged;
  } catch {
    cache = { at: Date.now(), value: defaults };
    return defaults;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();

  const next: Settings = {
    llm: { ...current.llm, ...(patch.llm ?? {}) },
    tts: { ...current.tts, ...(patch.tts ?? {}) },
    prefs: { ...current.prefs, ...(patch.prefs ?? {}) },
  };

  // An empty string from the UI means "leave the existing key alone",
  // otherwise saving any unrelated setting would clear the credential.
  if (!patch.llm?.apiKey) next.llm.apiKey = current.llm.apiKey;
  if (!patch.tts?.apiKey) next.tts.apiKey = current.tts.apiKey;

  if (kvEnabled()) {
    try {
      await redis(["SET", KEY, JSON.stringify(next)]);
    } catch {
      /* fall through — settings stay in-process for this instance */
    }
  }

  cache = { at: Date.now(), value: next };
  return next;
}

/** Strips secrets, leaving only whether a key is present. */
export function maskSettings(s: Settings) {
  return {
    llm: {
      providerId: s.llm.providerId,
      model: s.llm.model,
      baseUrl: s.llm.baseUrl ?? "",
      hasKey: !!s.llm.apiKey,
    },
    tts: {
      providerId: s.tts.providerId,
      voiceId: s.tts.voiceId,
      model: s.tts.model ?? "",
      baseUrl: s.tts.baseUrl ?? "",
      hasKey: !!s.tts.apiKey,
    },
    prefs: s.prefs,
    persistent: kvEnabled(),
  };
}
