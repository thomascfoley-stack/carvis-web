import { dbEnabled, dbLoadPrefs, dbSavePrefs } from "./db";

/**
 * Per-user preferences.
 *
 * These were global, which is wrong once anyone can sign up: two people would
 * share one name. They now live in Neon keyed by email, so what CARVIS calls
 * you is yours and survives a redeploy.
 */

export type Prefs = {
  /** What CARVIS calls you. Empty means "don't use any form of address". */
  userName: string;
  verbosity: "terse" | "balanced" | "detailed";
  autoListen: boolean;
  bargeIn: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  // Deliberately empty. "Sir" is a costume, not a default — if you haven't
  // said what to call you, CARVIS simply doesn't use a name.
  userName: "",
  verbosity: "balanced",
  autoListen: true,
  bargeIn: true,
};

/** Survives only until the instance recycles; used when Neon isn't attached. */
const fallback = new Map<string, Prefs>();

function coerce(raw: unknown): Prefs {
  const p = (raw ?? {}) as Partial<Prefs>;
  const v = p.verbosity;
  return {
    userName: typeof p.userName === "string" ? p.userName.trim().slice(0, 40) : "",
    verbosity: v === "terse" || v === "detailed" || v === "balanced" ? v : "balanced",
    autoListen: p.autoListen !== false,
    bargeIn: p.bargeIn !== false,
  };
}

export async function loadPrefs(email: string): Promise<Prefs> {
  if (!email) return { ...DEFAULT_PREFS };

  if (dbEnabled()) {
    try {
      const raw = await dbLoadPrefs(email);
      if (raw) return coerce(raw);
      return { ...DEFAULT_PREFS };
    } catch {
      /* fall through */
    }
  }
  return fallback.get(email) ?? { ...DEFAULT_PREFS };
}

export async function savePrefs(email: string, patch: Partial<Prefs>): Promise<Prefs> {
  if (!email) return { ...DEFAULT_PREFS };

  const current = await loadPrefs(email);
  const next = coerce({ ...current, ...patch });

  if (dbEnabled()) {
    try {
      await dbSavePrefs(email, next);
      return next;
    } catch {
      /* fall through */
    }
  }
  fallback.set(email, next);
  return next;
}

/** Just the name — the hot path, called on every chat turn. */
export async function preferredName(email: string): Promise<string> {
  return (await loadPrefs(email)).userName;
}
