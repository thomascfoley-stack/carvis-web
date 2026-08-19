import type { TtsSettings } from "../store";

import { defineNode } from "../graph";
import { redact } from "../redact";

/**
 * Provider-agnostic TTS layer.
 *
 * Every one of these is "POST JSON, get audio back" — they differ only in URL,
 * auth header, body field names, and whether the audio arrives as raw bytes or
 * base64 inside JSON. So each provider is a small descriptor and there is one
 * executor. Adding a provider is ~10 lines.
 *
 * Note: Anthropic does not ship a text-to-speech API, so it isn't listed here —
 * it's an LLM provider only.
 */

/** One selectable voice, normalised across providers. */
export type VoiceOption = {
  /** Exactly the value that goes into TtsSettings.voiceId. */
  id: string;
  label: string;
  /** Accent, gender, language — whatever the provider gives us worth showing. */
  tag?: string;
};

/**
 * How to enumerate a provider's voices.
 *
 * Most providers publish a list endpoint, so the catalogue is the user's own
 * library — their cloned voices, not just the stock ones. A few (OpenAI) have
 * a fixed set and no endpoint, so those are listed inline.
 */
type VoiceIndex = {
  fixed?: VoiceOption[];
  live?: {
    url: (s: TtsSettings) => string;
    headers: (s: TtsSettings) => Record<string, string>;
    /** Pull the array out of whatever shape this provider returns. */
    pick: (payload: any) => VoiceOption[];
    /**
     * Tried when the primary list is legitimately empty — e.g. Fish's
     * `self=true` personal library for someone who never uploaded a voice.
     */
    fallbackUrl?: (s: TtsSettings) => string;
  };
};

export type TtsProvider = {
  id: string;
  label: string;
  /** false for the in-browser engine, which needs no credentials. */
  needsKey: boolean;
  keyUrl: string;
  endpoint: (s: TtsSettings) => string;
  headers: (s: TtsSettings) => Record<string, string>;
  body: (text: string, s: TtsSettings) => unknown;
  /** How the audio comes back. */
  decode: "binary" | "base64-json";
  /** Dot path to the base64 payload when decode is base64-json. */
  audioPath?: string;
  defaultVoice: string;
  voiceLabel: string;
  models?: string[];
  defaultModel?: string;
  editableBaseUrl?: boolean;
  note?: string;
  voices?: VoiceIndex;
};

const json = { "content-type": "application/json" };

/** Shorthand for a fixed voice list where the id is also the display name. */
const named = (...ids: string[]): VoiceOption[] => ids.map((id) => ({ id, label: id }));

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Join whatever descriptive scraps a provider offers into one short tag. */
const tagOf = (...parts: unknown[]): string =>
  parts
    .map((p) => (typeof p === "string" ? p : ""))
    .filter(Boolean)
    .join(" · ")
    .slice(0, 60);

/** Providers nest their array under different keys; find it without guessing. */
function arrayIn(payload: any, ...keys: string[]): any[] {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}

/** Order matters: the first entry is the default shown to a new user. */
export const TTS_PROVIDERS: TtsProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    endpoint: () => "https://api.openai.com/v1/audio/speech",
    headers: (s) => ({ ...json, authorization: `Bearer ${s.apiKey}` }),
    body: (text, s) => ({
      model: s.model || "gpt-4o-mini-tts",
      input: text,
      voice: s.voiceId || "onyx",
      response_format: "mp3",
    }),
    decode: "binary",
    defaultVoice: "onyx",
    voiceLabel: "Voice name",
    models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
    defaultModel: "gpt-4o-mini-tts",
    note: "Onyx is the closest to a CARVIS read.",
    // OpenAI publishes no voices endpoint — the set is fixed and documented.
    voices: {
      fixed: [
        { id: "onyx", label: "onyx", tag: "deep, male — closest to CARVIS" },
        { id: "ash", label: "ash", tag: "male, expressive" },
        { id: "ballad", label: "ballad", tag: "male, warm" },
        { id: "echo", label: "echo", tag: "male, even" },
        { id: "fable", label: "fable", tag: "male, British" },
        { id: "verse", label: "verse", tag: "male, bright" },
        { id: "alloy", label: "alloy", tag: "neutral" },
        { id: "sage", label: "sage", tag: "neutral, calm" },
        { id: "coral", label: "coral", tag: "female, lively" },
        { id: "nova", label: "nova", tag: "female, crisp" },
        { id: "shimmer", label: "shimmer", tag: "female, soft" },
      ],
    },
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    needsKey: true,
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    endpoint: (s) =>
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voiceId)}?output_format=mp3_44100_128`,
    headers: (s) => ({ ...json, "xi-api-key": s.apiKey ?? "" }),
    body: (text, s) => ({
      text,
      model_id: s.model || "eleven_flash_v2_5",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    }),
    decode: "binary",
    defaultVoice: "JBFqnCBsd6RMkjVDRZzb",
    voiceLabel: "Voice ID",
    models: ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"],
    defaultModel: "eleven_flash_v2_5",
    note: "Flash v2.5 is the low-latency model — best fit for conversation.",
    voices: {
      live: {
        url: () => "https://api.elevenlabs.io/v2/voices?page_size=100",
        headers: (s) => ({ "xi-api-key": s.apiKey ?? "" }),
        pick: (p) =>
          arrayIn(p, "voices").map((v) => ({
            id: str(v?.voice_id),
            label: str(v?.name) || str(v?.voice_id),
            tag: tagOf(v?.labels?.accent, v?.labels?.gender, v?.category),
          })),
      },
    },
  },
  {
    id: "deepgram",
    label: "Deepgram Aura",
    needsKey: true,
    keyUrl: "https://console.deepgram.com",
    endpoint: (s) =>
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(s.voiceId || "aura-2-thalia-en")}`,
    headers: (s) => ({ ...json, authorization: `Token ${s.apiKey}` }),
    body: (text) => ({ text }),
    decode: "binary",
    defaultVoice: "aura-2-thalia-en",
    voiceLabel: "Model / voice",
    note: "Among the lowest time-to-first-byte of any hosted TTS.",
    voices: {
      live: {
        url: () => "https://api.deepgram.com/v1/models",
        headers: (s) => ({ authorization: `Token ${s.apiKey}` }),
        // Deepgram returns every model; only the tts array is a voice.
        pick: (p) =>
          arrayIn(p, "tts").map((v) => ({
            id: str(v?.canonical_name) || str(v?.name),
            label: str(v?.name) || str(v?.canonical_name),
            tag: tagOf(v?.metadata?.accent, (v?.languages ?? [])[0], v?.architecture),
          })),
      },
    },
  },
  {
    id: "cartesia",
    label: "Cartesia Sonic",
    needsKey: true,
    keyUrl: "https://play.cartesia.ai",
    endpoint: () => "https://api.cartesia.ai/tts/bytes",
    headers: (s) => ({
      ...json,
      "X-API-Key": s.apiKey ?? "",
      "Cartesia-Version": "2024-06-10",
    }),
    body: (text, s) => ({
      model_id: s.model || "sonic-2",
      transcript: text,
      voice: { mode: "id", id: s.voiceId },
      output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
    }),
    decode: "binary",
    defaultVoice: "a0e99841-438c-4a64-b679-ae501e7d6091",
    voiceLabel: "Voice ID",
    models: ["sonic-2", "sonic-turbo"],
    defaultModel: "sonic-2",
    voices: {
      live: {
        url: () => "https://api.cartesia.ai/voices?limit=100",
        // Cartesia accepts either header depending on key vintage; send both.
        headers: (s) => ({
          "X-API-Key": s.apiKey ?? "",
          authorization: `Bearer ${s.apiKey}`,
          "Cartesia-Version": "2024-06-10",
        }),
        pick: (p) =>
          arrayIn(p, "data", "voices").map((v) => ({
            id: str(v?.id),
            label: str(v?.name) || str(v?.id),
            tag: tagOf(v?.gender, v?.language, v?.tagline ?? v?.description),
          })),
      },
    },
  },
  {
    id: "lmnt",
    label: "LMNT",
    needsKey: true,
    keyUrl: "https://app.lmnt.com/account",
    endpoint: () => "https://api.lmnt.com/v1/ai/speech/bytes",
    headers: (s) => ({ ...json, "X-API-Key": s.apiKey ?? "" }),
    body: (text, s) => ({
      voice: s.voiceId || "morgan",
      text,
      model: s.model || "blizzard",
      format: "mp3",
    }),
    decode: "binary",
    defaultVoice: "morgan",
    voiceLabel: "Voice name",
    models: ["blizzard", "aurora"],
    defaultModel: "blizzard",
    voices: {
      live: {
        url: () => "https://api.lmnt.com/v1/ai/voice/list",
        headers: (s) => ({ "X-API-Key": s.apiKey ?? "" }),
        pick: (p) =>
          arrayIn(p, "voices").map((v) => ({
            id: str(v?.id) || str(v?.name),
            label: str(v?.name) || str(v?.id),
            tag: tagOf(v?.gender, v?.description),
          })),
      },
    },
  },
  {
    id: "rime",
    label: "Rime",
    needsKey: true,
    keyUrl: "https://rime.ai/dashboard/tokens",
    endpoint: () => "https://users.rime.ai/v1/rime-tts",
    headers: (s) => ({ ...json, accept: "audio/mp3", authorization: `Bearer ${s.apiKey}` }),
    body: (text, s) => ({
      text,
      speaker: s.voiceId || "cove",
      modelId: s.model || "mistv2",
    }),
    decode: "binary",
    defaultVoice: "cove",
    voiceLabel: "Speaker",
    models: ["mistv2", "mist"],
    defaultModel: "mistv2",
    voices: {
      live: {
        url: () => "https://users.rime.ai/data/voices/all",
        headers: (s) => ({ authorization: `Bearer ${s.apiKey}` }),
        // Rime groups speakers by model and returns bare strings, not objects.
        pick: (p) => {
          const out: VoiceOption[] = [];
          const eat = (list: unknown, group: string) => {
            for (const v of Array.isArray(list) ? list : []) {
              if (typeof v === "string") out.push({ id: v, label: v, tag: group });
              else if (v?.name) out.push({ id: str(v.name), label: str(v.name), tag: group });
            }
          };
          if (Array.isArray(p)) eat(p, "");
          else for (const [group, list] of Object.entries(p ?? {})) eat(list, group);
          return out;
        },
      },
    },
  },
  {
    id: "hume",
    label: "Hume Octave",
    needsKey: true,
    keyUrl: "https://platform.hume.ai/settings/keys",
    endpoint: () => "https://api.hume.ai/v0/tts/file",
    headers: (s) => ({ ...json, "X-Hume-Api-Key": s.apiKey ?? "" }),
    body: (text, s) => ({
      utterances: [{ text, voice: { name: s.voiceId || "Male English Actor" } }],
      format: { type: "mp3" },
    }),
    decode: "binary",
    defaultVoice: "Male English Actor",
    voiceLabel: "Voice name",
    note: "Octave can act a line rather than just read it.",
    voices: {
      live: {
        url: () => "https://api.hume.ai/v0/tts/voices?provider=HUME_AI&page_size=100",
        headers: (s) => ({ "X-Hume-Api-Key": s.apiKey ?? "" }),
        // Hume's synthesis body takes the voice *name*, not the id.
        pick: (p) =>
          arrayIn(p, "voices_page", "voices").map((v) => ({
            id: str(v?.name),
            label: str(v?.name),
            tag: tagOf(v?.provider),
          })),
      },
    },
  },
  {
    id: "speechify",
    label: "Speechify",
    needsKey: true,
    keyUrl: "https://console.sws.speechify.com",
    endpoint: () => "https://api.sws.speechify.com/v1/audio/speech",
    headers: (s) => ({ ...json, authorization: `Bearer ${s.apiKey}` }),
    body: (text, s) => ({
      input: text,
      voice_id: s.voiceId || "george",
      audio_format: "mp3",
    }),
    decode: "base64-json",
    audioPath: "audio_data",
    defaultVoice: "george",
    voiceLabel: "Voice ID",
    voices: {
      live: {
        url: () => "https://api.sws.speechify.com/v1/voices",
        headers: (s) => ({ authorization: `Bearer ${s.apiKey}` }),
        pick: (p) =>
          arrayIn(p, "voices", "data").map((v) => ({
            id: str(v?.id),
            label: str(v?.display_name) || str(v?.id),
            tag: tagOf(v?.gender, v?.locale),
          })),
      },
    },
  },
  {
    id: "google",
    label: "Google Cloud TTS",
    needsKey: true,
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    endpoint: (s) =>
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(s.apiKey ?? "")}`,
    headers: () => ({ ...json }),
    body: (text, s) => ({
      input: { text },
      voice: {
        languageCode: (s.voiceId || "en-GB-Neural2-B").split("-").slice(0, 2).join("-"),
        name: s.voiceId || "en-GB-Neural2-B",
      },
      audioConfig: { audioEncoding: "MP3" },
    }),
    decode: "base64-json",
    audioPath: "audioContent",
    defaultVoice: "en-GB-Neural2-B",
    voiceLabel: "Voice name",
    note: "Uses an API key, not a service account. en-GB-Neural2-B is a good CARVIS match.",
    voices: {
      live: {
        url: (s) =>
          `https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(s.apiKey ?? "")}`,
        headers: () => ({}),
        pick: (p) =>
          arrayIn(p, "voices").map((v) => ({
            id: str(v?.name),
            label: str(v?.name),
            tag: tagOf((v?.languageCodes ?? [])[0], v?.ssmlGender?.toLowerCase?.()),
          })),
      },
    },
  },
  {
    id: "fish",
    label: "Fish Audio",
    needsKey: true,
    keyUrl: "https://fish.audio/go/api",
    endpoint: () => "https://api.fish.audio/v1/tts",
    headers: (s) => ({ ...json, authorization: `Bearer ${s.apiKey}`, model: s.model || "speech-1.6" }),
    body: (text, s) => ({
      text,
      reference_id: s.voiceId,
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal",
      normalize: true,
    }),
    decode: "binary",
    defaultVoice: "612b878b113047d9a770c069c8b4fdfe",
    voiceLabel: "Reference / model ID",
    models: ["speech-1.6", "speech-1.5", "s1"],
    defaultModel: "speech-1.6",
    note: "Hosts the original CARVIS voice model used by the upstream macOS app.",
    voices: {
      live: {
        // `self=true` returns the caller's own library rather than the whole
        // public catalogue, which runs to tens of thousands of models. An
        // account with no uploads gets the public top hundred instead of an
        // empty picker.
        url: () => "https://api.fish.audio/model?page_size=100&self=true",
        fallbackUrl: () => "https://api.fish.audio/model?page_size=100&sort_by=score",
        headers: (s) => ({ authorization: `Bearer ${s.apiKey}` }),
        pick: (p) =>
          arrayIn(p, "items", "data").map((v) => ({
            id: str(v?._id) || str(v?.id),
            label: str(v?.title) || str(v?._id),
            tag: tagOf(v?.languages?.[0], v?.visibility),
          })),
      },
    },
  },
  {
    id: "browser",
    label: "Browser (built-in, free)",
    needsKey: false,
    keyUrl: "",
    endpoint: () => "",
    headers: () => ({}),
    body: () => ({}),
    decode: "binary",
    defaultVoice: "",
    voiceLabel: "System voice name",
    note: "Runs entirely on-device via the Web Speech API. No key, no cost, no network hop — but robotic.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    needsKey: true,
    keyUrl: "",
    endpoint: (s) => `${(s.baseUrl || "").replace(/\/+$/, "")}/audio/speech`,
    headers: (s) => ({ ...json, authorization: `Bearer ${s.apiKey}` }),
    body: (text, s) => ({
      model: s.model || "tts-1",
      input: text,
      voice: s.voiceId || "alloy",
      response_format: "mp3",
    }),
    decode: "binary",
    defaultVoice: "alloy",
    voiceLabel: "Voice name",
    editableBaseUrl: true,
    note: "Point at any /v1/audio/speech-compatible server, including local ones.",
  },
];

export function findTts(id: string): TtsProvider {
  return TTS_PROVIDERS.find((p) => p.id === id) ?? TTS_PROVIDERS[0];
}

function dig(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

type SynthResult = { ok: true; audio: ArrayBuffer } | { ok: false; error: string };

/**
 * `{ok:false}` results that describe the user's configuration, not a defect.
 * They must stay out of the failures table or they drown it. In a BYOK app a
 * 401/403 from the user's own key is configuration too — a missing key and a
 * revoked one are the same problem with different spellings.
 */
export const isConfigState = (error: string) =>
  error === "browser-tts" ||
  / API key configured\.$/.test(error) ||
  /key first\.$/.test(error) ||
  /\s40[13]:/.test(error);

async function synthesizeBody(
  text: string,
  s: TtsSettings,
  signal?: AbortSignal,
): Promise<SynthResult> {
  const provider = findTts(s.providerId);

  if (provider.id === "browser") {
    return { ok: false, error: "browser-tts" };
  }
  if (provider.needsKey && !s.apiKey) {
    return { ok: false, error: `No ${provider.label} API key configured.` };
  }

  let res: Response;
  try {
    res = await fetch(provider.endpoint(s), {
      method: "POST",
      headers: provider.headers(s),
      body: JSON.stringify(provider.body(text, s)),
      signal,
    });
  } catch (e) {
    return { ok: false, error: `Could not reach ${provider.label}: ${redact(e).slice(0, 160)}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `${provider.label} ${res.status}: ${redact(detail).slice(0, 200)}` };
  }

  if (provider.decode === "binary") {
    return { ok: true, audio: await res.arrayBuffer() };
  }

  const payload = await res.json().catch(() => null);
  const b64 = dig(payload, provider.audioPath ?? "");
  if (typeof b64 !== "string" || !b64) {
    return { ok: false, error: `${provider.label} returned no audio.` };
  }

  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ok: true, audio: bytes.buffer };
}

/**
 * The reproduction sample is ids and a length only. Never the settings object
 * (it carries the key) and never the spoken text (it's the user's words — a
 * length reproduces a payload-size bug just as well).
 */
const synthNode = defineNode<{ text: string; s: TtsSettings }, SynthResult>({
  id: (a) => `tts.${findTts(a.s.providerId).id}`,
  run: (a, ctx) => synthesizeBody(a.text, a.s, ctx.signal),
  soft: (r) =>
    !r.ok && !isConfigState(r.error) ? { class: "SynthesisFailed", message: r.error } : null,
  sample: (a) => ({
    provider: a.s.providerId,
    voice: a.s.voiceId,
    model: a.s.model,
    textLen: a.text.length,
  }),
});

/** Runs a provider descriptor and returns MP3 bytes. */
export const synthesize = (text: string, s: TtsSettings, signal?: AbortSignal) =>
  synthNode({ text, s }, { signal });

/* ---------------------------- voice catalogue --------------------------- */

/**
 * Last resort when a provider's response shape has drifted: walk the payload
 * for anything that looks like a voice. Better a slightly odd label than an
 * empty picker and a free-text box.
 */
function sniff(payload: unknown, depth = 0): VoiceOption[] {
  if (depth > 3 || !payload || typeof payload !== "object") return [];

  if (Array.isArray(payload)) {
    const out: VoiceOption[] = [];
    for (const item of payload) {
      if (typeof item === "string") {
        out.push({ id: item, label: item });
        continue;
      }
      const o = item as Record<string, unknown>;
      const id = str(o?.id ?? o?._id ?? o?.voice_id ?? o?.canonical_name ?? o?.name);
      if (!id) continue;
      out.push({ id, label: str(o?.name ?? o?.title ?? o?.display_name) || id });
    }
    return out;
  }

  for (const v of Object.values(payload as Record<string, unknown>)) {
    const found = sniff(v, depth + 1);
    if (found.length) return found;
  }
  return [];
}

export type VoiceListResult =
  | { ok: true; voices: VoiceOption[]; live: boolean }
  | { ok: false; error: string };

/**
 * Enumerate a provider's voices using the caller's own key.
 *
 * Runs server-side for the same reason synthesis does: the key must not reach
 * the browser. A provider with no listing capability is not an error — the UI
 * simply keeps its free-text field.
 */
async function pullVoices(
  live: NonNullable<VoiceIndex["live"]>,
  url: string,
  label: string,
  s: TtsSettings,
  signal?: AbortSignal,
): Promise<VoiceOption[] | { error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", ...live.headers(s) },
      signal,
    });
  } catch (e) {
    return { error: `Could not reach ${label}: ${redact(e).slice(0, 160)}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: `${label} ${res.status}: ${redact(detail).slice(0, 200)}` };
  }

  const payload = await res.json().catch(() => null);
  if (!payload) return { error: `${label} returned no voice list.` };

  let voices: VoiceOption[] = [];
  try {
    voices = live.pick(payload);
  } catch {
    /* shape drifted — fall through to sniff */
  }
  voices = voices.filter((v) => v.id);
  if (!voices.length) voices = sniff(payload);
  return voices;
}

async function fetchVoicesBody(s: TtsSettings, signal?: AbortSignal): Promise<VoiceListResult> {
  const provider = findTts(s.providerId);
  const index = provider.voices;

  if (index?.fixed) return { ok: true, voices: index.fixed, live: false };
  if (!index?.live) return { ok: true, voices: [], live: false };
  if (provider.needsKey && !s.apiKey) {
    return { ok: false, error: `Add your ${provider.label} key first.` };
  }

  const first = await pullVoices(index.live, index.live.url(s), provider.label, s, signal);
  if (!Array.isArray(first)) return { ok: false, error: first.error };

  let voices = first;
  // An empty personal library is not an error — offer the public list.
  if (!voices.length && index.live.fallbackUrl) {
    const second = await pullVoices(index.live, index.live.fallbackUrl(s), provider.label, s, signal);
    // The fallback's own failure IS the diagnosis. Discarding it flattened a
    // 401 from the user's key or a 429 from the provider into the generic
    // "returned no voices", which hides the cause from the user and, because
    // the config-state and retry predicates both match on the error text,
    // captured user configuration and upstream throttling as defects.
    if (!Array.isArray(second)) return { ok: false, error: second.error };
    voices = second;
  }
  if (!voices.length) return { ok: false, error: `${provider.label} returned no voices.` };

  // Google alone returns well over a thousand; sort English first and cap so
  // the picker stays usable and the cached row stays small.
  const en = (v: VoiceOption) => /(^|[^a-z])en([^a-z]|$)/i.test(`${v.id} ${v.tag ?? ""}`);
  voices.sort((a, b) => (en(b) ? 1 : 0) - (en(a) ? 1 : 0) || a.label.localeCompare(b.label));

  return { ok: true, voices: voices.slice(0, 500), live: true };
}

/**
 * A settings-page list is worth one silent retry when the provider blips —
 * network failures and 5xx only. A 4xx means the request itself is wrong and
 * will be wrong again.
 */
const voicesNode = defineNode<TtsSettings, VoiceListResult>({
  id: (s) => `voices.${findTts(s.providerId).id}`,
  run: (s, ctx) => fetchVoicesBody(s, ctx.signal),
  soft: (r) =>
    !r.ok && !isConfigState(r.error) ? { class: "VoiceListFailed", message: r.error } : null,
  retryOnce: (m) => /^Could not reach /.test(m) || /\s5\d\d:/.test(m),
  sample: (s) => ({ provider: s.providerId }),
});

export const fetchVoices = (s: TtsSettings, signal?: AbortSignal) => voicesNode(s, { signal });

/** Registry shipped to the settings UI — descriptors are functions, so strip them. */
export function ttsCatalogue() {
  return TTS_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    needsKey: p.needsKey,
    keyUrl: p.keyUrl,
    defaultVoice: p.defaultVoice,
    voiceLabel: p.voiceLabel,
    models: p.models ?? [],
    defaultModel: p.defaultModel ?? "",
    editableBaseUrl: !!p.editableBaseUrl,
    note: p.note ?? "",
    /** Whether the UI can offer a picker, and whether it costs a network call. */
    listable: !!(p.voices?.fixed || p.voices?.live),
    listLive: !!p.voices?.live,
  }));
}
