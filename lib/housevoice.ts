/**
 * The deployment's own voice.
 *
 * CARVIS is otherwise strictly bring-your-own-key, and for the model it stays
 * that way — inference is the expensive part and it bills the caller. Voice is
 * different: it is the whole first impression, and asking someone to go and
 * create a Fish account before they can hear anything loses most of them at
 * the door. So the deployment supplies one voice for everyone.
 *
 * The key lives ONLY in the server environment. It is never returned by any
 * route, never included in maskCredentials, and never reaches a browser — the
 * /api/tts proxy exists precisely so audio can be produced without the key
 * leaving the server. A user who sets their own voice key still overrides
 * this; the house voice is a floor, not a ceiling.
 *
 * Because one key now serves every user, it is also a shared cost and a shared
 * abuse surface — see the daily character budget in the TTS route, which
 * applies ONLY to the house key. Someone spending their own key is their own
 * business.
 */

const env = (name: string): string => (process.env[name] ?? "").trim();
const cfg = (suffix: string): string => env(`CARVIS_${suffix}`) || env(`JARVIS_${suffix}`);

export type HouseVoice = {
  providerId: string;
  apiKey: string;
  voiceId: string;
  model: string;
};

/**
 * "Super Smash Bros. 4/Ultimate Announcer" from Fish's public catalogue —
 * the deliberate default, overridable per-deployment without a code change.
 */
const DEFAULT_VOICE_ID = "90e65eaaf50e4470b8e6d43ee6afd7d5";
const DEFAULT_PROVIDER = "fish";
const DEFAULT_MODEL = "speech-1.6";

/**
 * Where the key comes from, in order of specificity.
 *
 * CARVIS_TTS_KEY is the explicit setting and can name any provider. FISH_API_KEY
 * is the conventional name a Fish key already tends to be stored under, and
 * accepting it means an operator who has one configured gets the house voice
 * without having to duplicate the secret under a second name — one fewer copy
 * of a credential in the world.
 */
function houseKey(): { apiKey: string; impliedProvider: string } | null {
  const explicit = cfg("TTS_KEY");
  if (explicit) return { apiKey: explicit, impliedProvider: DEFAULT_PROVIDER };
  const fish = env("FISH_API_KEY");
  // A key named for Fish is a Fish key: don't let an unrelated TTS_PROVIDER
  // send it somewhere it cannot possibly authenticate.
  if (fish) return { apiKey: fish, impliedProvider: "fish" };
  return null;
}

/** Configured when — and only when — the deployment has supplied a key. */
export function houseVoice(): HouseVoice | null {
  const key = houseKey();
  if (!key) return null;
  return {
    providerId: cfg("TTS_PROVIDER") || key.impliedProvider,
    apiKey: key.apiKey,
    voiceId: cfg("TTS_VOICE") || DEFAULT_VOICE_ID,
    model: cfg("TTS_MODEL") || DEFAULT_MODEL,
  };
}

/** Safe to tell the browser: whether a voice is provided, never which key. */
export function houseVoiceAvailable(): boolean {
  return !!houseKey();
}

/**
 * Characters per user per day on the *house* key.
 *
 * Roughly two hours of speech — far past any honest day's use, and a hard
 * ceiling on what one account can spend of someone else's money. Exceeding it
 * degrades to the user's own key or the on-device voice rather than failing
 * the turn.
 */
export const HOUSE_DAILY_CHAR_BUDGET = Number(cfg("TTS_DAILY_CHARS") || 120_000);
