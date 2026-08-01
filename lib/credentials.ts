import { decryptSecret, encryptSecret, maskSecret, masterKeyId } from "./crypto";
import { dbEnabled, dbLoadCredentials, dbSaveCredentials } from "./db";

/**
 * Per-user credentials — bring-your-own-key.
 *
 * There is no owner default for the model or voice keys. Each user supplies
 * their own, so nobody spends anyone else's money and there is no quota to
 * enforce. Stored encrypted (see crypto.ts) and never returned to the browser
 * in full.
 *
 * The one exception is the deployment's own COMPOSIO_API_KEY, which is used
 * *only* to broker Google sign-in. It grants no access to user data.
 */

export type Credentials = {
  /** The user's own Composio MCP endpoint URL. */
  mcpUrl: string;
  /** The user's own Composio API key, for that endpoint. */
  composioKey: string;
  /** Model provider. */
  llmProvider: string;
  llmModel: string;
  llmKey: string;
  /** Voice provider. */
  ttsProvider: string;
  ttsVoice: string;
  ttsModel: string;
  ttsKey: string;
};

export const EMPTY: Credentials = {
  mcpUrl: "",
  composioKey: "",
  llmProvider: "anthropic",
  llmModel: "claude-haiku-4-5-20251001",
  llmKey: "",
  ttsProvider: "openai",
  ttsVoice: "onyx",
  ttsModel: "gpt-4o-mini-tts",
  ttsKey: "",
};

const SECRET_FIELDS = ["composioKey", "llmKey", "ttsKey"] as const;

/** Stamp recording which master key encrypted this row. Never a credential. */
const KID = "_kid";

const fallback = new Map<string, Credentials>();

export async function loadCredentials(email: string): Promise<Credentials> {
  if (!email) return { ...EMPTY };

  if (dbEnabled()) {
    try {
      const raw = (await dbLoadCredentials(email)) as Record<string, string> | null;
      if (!raw) return { ...EMPTY };

      const out: Credentials = { ...EMPTY, ...raw } as Credentials;
      delete (out as Record<string, unknown>)[KID];
      for (const f of SECRET_FIELDS) {
        out[f] = await decryptSecret(String(raw[f] ?? ""));
      }
      return out;
    } catch {
      /* fall through */
    }
  }
  return fallback.get(email) ?? { ...EMPTY };
}

export async function saveCredentials(
  email: string,
  patch: Partial<Credentials>,
): Promise<Credentials> {
  if (!email) return { ...EMPTY };

  const current = await loadCredentials(email);
  const next: Credentials = { ...current };

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    const key = k as keyof Credentials;
    // A blank secret means "leave the stored one alone" — otherwise saving an
    // unrelated field would silently wipe a working key.
    if ((SECRET_FIELDS as readonly string[]).includes(key) && String(v).trim() === "") continue;
    next[key] = String(v).trim();
  }

  // Switching provider must invalidate the key. "Blank means keep" is right
  // when you're editing one field, and badly wrong here: an OpenAI key is not
  // a Fish key, so keeping it sends the old provider's credential to the new
  // provider's endpoint and every call fails with a baffling 401 — which reads
  // as "my new key didn't take".
  if (patch.llmProvider && patch.llmProvider !== current.llmProvider) {
    if (!String(patch.llmKey ?? "").trim()) next.llmKey = "";
  }
  if (patch.ttsProvider && patch.ttsProvider !== current.ttsProvider) {
    if (!String(patch.ttsKey ?? "").trim()) next.ttsKey = "";
  }

  if (dbEnabled()) {
    try {
      const encrypted: Record<string, string> = { ...next };
      for (const f of SECRET_FIELDS) encrypted[f] = await encryptSecret(next[f]);
      encrypted[KID] = await masterKeyId();
      await dbSaveCredentials(email, encrypted);
      return next;
    } catch {
      /* fall through */
    }
  }
  fallback.set(email, next);
  return next;
}

/**
 * Did we store secrets that we can no longer read?
 *
 * This is the difference between "you never saved a key" and "your key is
 * still here but the server can't open it any more". They look identical from
 * the browser — both render as "not set" — and only one of them is the user's
 * fault. Worth one extra query on a settings page nobody loads in a loop.
 */
export async function secretsUnreadable(email: string): Promise<boolean> {
  if (!email || !dbEnabled()) return false;
  try {
    const raw = (await dbLoadCredentials(email)) as Record<string, string> | null;
    if (!raw) return false;
    if (!SECRET_FIELDS.some((f) => !!raw[f])) return false;

    const stamp = raw[KID];
    // Rows written before the stamp existed: prove it by attempting a decrypt.
    if (!stamp) {
      for (const f of SECRET_FIELDS) {
        if (raw[f] && !(await decryptSecret(raw[f]))) return true;
      }
      return false;
    }
    return stamp !== (await masterKeyId());
  } catch {
    return false;
  }
}

/** True once the user has supplied everything the app needs to function. */
export function isOnboarded(c: Credentials): boolean {
  return !!(c.composioKey && c.llmKey && c.ttsKey);
}

/** What the browser is allowed to see: presence and a masked hint, never the key. */
export function maskCredentials(c: Credentials) {
  return {
    mcpUrl: c.mcpUrl,
    llmProvider: c.llmProvider,
    llmModel: c.llmModel,
    ttsProvider: c.ttsProvider,
    ttsVoice: c.ttsVoice,
    ttsModel: c.ttsModel,
    composioKey: { set: !!c.composioKey, hint: maskSecret(c.composioKey) },
    llmKey: { set: !!c.llmKey, hint: maskSecret(c.llmKey) },
    ttsKey: { set: !!c.ttsKey, hint: maskSecret(c.ttsKey) },
    onboarded: isOnboarded(c),
  };
}
