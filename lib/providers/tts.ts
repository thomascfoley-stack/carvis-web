import type { TtsSettings } from "../store";

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
};

const json = { "content-type": "application/json" };

export const TTS_PROVIDERS: TtsProvider[] = [
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
    note: "Hosts the original JARVIS voice model. This is the upstream default.",
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
  },
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
    note: "Voices: alloy, echo, fable, onyx, nova, shimmer, ash, sage.",
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
    note: "Uses an API key, not a service account. en-GB-Neural2-B is a good JARVIS match.",
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

/** Runs a provider descriptor and returns MP3 bytes. */
export async function synthesize(
  text: string,
  s: TtsSettings,
  signal?: AbortSignal,
): Promise<{ ok: true; audio: ArrayBuffer } | { ok: false; error: string }> {
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
    return { ok: false, error: `Could not reach ${provider.label}: ${String(e).slice(0, 160)}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `${provider.label} ${res.status}: ${detail.slice(0, 200)}` };
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
  }));
}
