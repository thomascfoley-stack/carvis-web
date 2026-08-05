import { decryptSecret, encryptSecret, maskSecret, masterKeyId } from "./crypto";
import { dbEnabled, dbLoadCredentials, dbSaveCredentials } from "./db";
import { houseVoiceAvailable } from "./housevoice";

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
  /**
   * The user's own Composio API key, for key-authenticated endpoints. With
   * the OAuth flow (mcpToken below) this is optional — pasting the MCP URL
   * and clicking Connect is the whole setup.
   */
  composioKey: string;
  /** OAuth access token for the MCP endpoint, from the Connect flow. */
  mcpToken: string;
  /** OAuth refresh token; rotates the access token without re-consent. */
  mcpRefresh: string;
  /** The public client id this deployment registered with the auth server. */
  mcpClientId: string;
  /** Token endpoint used for refresh. */
  mcpTokenUrl: string;
  /** Access-token expiry, unix seconds as a string. */
  mcpTokenExp: string;
  /** Model provider. */
  llmProvider: string;
  llmModel: string;
  llmKey: string;
  /** Only meaningful for the custom providers, which have no fixed endpoint. */
  llmBaseUrl: string;
  /** Voice provider. */
  ttsProvider: string;
  ttsVoice: string;
  ttsModel: string;
  ttsKey: string;
  ttsBaseUrl: string;
};

export const EMPTY: Credentials = {
  mcpUrl: "",
  composioKey: "",
  mcpToken: "",
  mcpRefresh: "",
  mcpClientId: "",
  mcpTokenUrl: "",
  mcpTokenExp: "",
  llmProvider: "anthropic",
  llmModel: "claude-haiku-4-5-20251001",
  llmKey: "",
  llmBaseUrl: "",
  ttsProvider: "openai",
  ttsVoice: "onyx",
  ttsModel: "gpt-4o-mini-tts",
  ttsKey: "",
  ttsBaseUrl: "",
};

/**
 * A user-supplied endpoint must be somewhere we can genuinely send a key:
 * https only (a stray http:// URL would put the bearer token on the wire in
 * the clear), and never a private/loopback address — this runs server-side,
 * so an internal URL here is an SSRF invitation.
 *
 * CARVIS_ALLOW_INSECURE_BASEURL exists for the local test harness, which
 * points the custom providers at mock servers on 127.0.0.1. Never set it in
 * production.
 */
export function acceptableBaseUrl(raw: string): boolean {
  if (!raw) return true;
  const insecure =
    process.env.CARVIS_ALLOW_INSECURE_BASEURL || process.env.JARVIS_ALLOW_INSECURE_BASEURL;
  if ((insecure || "").trim() === "1") {
    try {
      new URL(raw);
      return true;
    } catch {
      return false;
    }
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return !isPrivateHost(u.hostname);
}

/** Is this v4 literal in a range we must never let the server be pointed at? */
function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Reject anything that resolves inward.
 *
 * Textual pattern-matching on the serialized host was not enough: an IPv6
 * literal can spell a loopback address several ways, and an IPv4-mapped form
 * like [::ffff:127.0.0.1] contains the v4 address as a *suffix*, so a
 * leading-anchored test never sees it. This parses instead of guessing.
 */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (isPrivateV4(host)) return true;

  if (host.includes(":")) {
    // Unspecified (::), loopback (::1), link-local (fe80::/10), ULA (fc00::/7).
    if (host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true;
    // IPv4-mapped/compatible in dotted form, e.g. ::ffff:127.0.0.1
    const tail = host.slice(host.lastIndexOf(":") + 1);
    if (tail.includes(".") && isPrivateV4(tail)) return true;

    // …and the same address written as hextets, e.g. ::ffff:7f00:1 = 127.0.0.1
    const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
      if (isPrivateV4(dotted)) return true;
    }
  }
  return false;
}

const SECRET_FIELDS = ["composioKey", "llmKey", "ttsKey", "mcpToken", "mcpRefresh"] as const;

/**
 * "Blank means keep" protects stored secrets from accidental wipes, which
 * means genuinely clearing one needs an explicit sentinel. Internal use only
 * (the OAuth flow retiring a dead token); request bodies never carry it.
 */
export const CLEAR_SECRET = "__CLEAR__";

/** Stamp recording which master key encrypted this row. Never a credential. */
const KID = "_kid";

const fallback = new Map<string, Credentials>();

/**
 * Short-TTL read cache. A single spoken reply hits this once for the chat
 * turn and once per sentence for TTS — five sentences means six DB reads and
 * six AES decrypts of identical data. 30 seconds of staleness is invisible
 * (saves invalidate locally anyway) and removes the per-sentence round trip.
 */
const TTL_MS = 30_000;
const recent = new Map<string, { at: number; creds: Credentials }>();

/**
 * The credential store could not be read. Distinct from "this user has no
 * credentials", which is a legitimate empty answer — conflating the two is how
 * a database blip logs an onboarded user out, and how the following save
 * overwrites five encrypted secrets with empty strings.
 */
export class CredentialsUnavailable extends Error {
  constructor() {
    super("The credential store is unavailable.");
    this.name = "CredentialsUnavailable";
  }
}

type Stored =
  | { ok: true; creds: Credentials; raw: Record<string, string> | null }
  | { ok: false };

/** The honest read: says whether it actually reached the store. */
async function loadStored(email: string): Promise<Stored> {
  if (!dbEnabled()) {
    return { ok: true, creds: fallback.get(email) ?? { ...EMPTY }, raw: null };
  }
  try {
    const raw = (await dbLoadCredentials(email)) as Record<string, string> | null;
    if (!raw) return { ok: true, creds: { ...EMPTY }, raw: null };

    const out: Credentials = { ...EMPTY, ...raw } as Credentials;
    delete (out as Record<string, unknown>)[KID];
    for (const f of SECRET_FIELDS) {
      out[f] = await decryptSecret(String(raw[f] ?? ""));
    }
    return { ok: true, creds: out, raw };
  } catch {
    return { ok: false };
  }
}

export async function loadCredentials(email: string): Promise<Credentials> {
  if (!email) return { ...EMPTY };

  const hit = recent.get(email);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.creds };

  const stored = await loadStored(email);
  if (stored.ok) {
    if (dbEnabled() && stored.raw) {
      recent.set(email, { at: Date.now(), creds: { ...stored.creds } });
      if (recent.size > 5000) recent.clear(); // bounded, crude, sufficient
    }
    return stored.creds;
  }

  // The read failed. An in-process fallback is better than nothing; with no
  // fallback we must NOT answer "you have no credentials", because callers
  // treat that as "not onboarded" and send the user back to Setup.
  const fb = fallback.get(email);
  if (fb) return { ...fb };
  throw new CredentialsUnavailable();
}

export async function saveCredentials(
  email: string,
  patch: Partial<Credentials>,
): Promise<Credentials> {
  if (!email) return { ...EMPTY };

  // Never merge a patch onto a baseline we failed to read: every secret the
  // caller did not mention would be written back as an empty string, which
  // destroys five working keys because one unrelated field was saved.
  const stored = await loadStored(email);
  if (!stored.ok) throw new CredentialsUnavailable();

  const current = stored.creds;
  const priorRaw = stored.raw ?? {};
  const next: Credentials = { ...current };

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    const key = k as keyof Credentials;
    // A blank secret means "leave the stored one alone" — otherwise saving an
    // unrelated field would silently wipe a working key. CLEAR_SECRET is the
    // explicit opposite: genuinely forget it.
    if ((SECRET_FIELDS as readonly string[]).includes(key)) {
      if (v === CLEAR_SECRET) {
        next[key] = "";
        continue;
      }
      if (String(v).trim() === "") continue;
    }
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

  // An OAuth token is bound to the endpoint it was issued for. A new MCP URL
  // means the old grant is meaningless — clear it so Setup honestly shows
  // "connect" again instead of sending the wrong server someone else's token.
  if (patch.mcpUrl !== undefined && String(patch.mcpUrl).trim() !== current.mcpUrl) {
    next.mcpToken = "";
    next.mcpRefresh = "";
    next.mcpClientId = "";
    next.mcpTokenUrl = "";
    next.mcpTokenExp = "";
  }

  // Refuse rather than store an endpoint we'd be unwilling to call. The MCP
  // URL is included: it's fetched server-side with full request control, which
  // makes an internal address here a textbook SSRF pivot.
  if (!acceptableBaseUrl(next.llmBaseUrl)) next.llmBaseUrl = current.llmBaseUrl ?? "";
  if (!acceptableBaseUrl(next.ttsBaseUrl)) next.ttsBaseUrl = current.ttsBaseUrl ?? "";
  if (next.mcpUrl && !acceptableBaseUrl(next.mcpUrl)) next.mcpUrl = current.mcpUrl ?? "";

  recent.delete(email);

  if (dbEnabled()) {
    try {
      const encrypted: Record<string, string> = { ...next };
      // A secret that decrypted to nothing but is non-empty on disk was not
      // "unset" — it was unreadable, which is what a rotated master key looks
      // like. Re-encrypting that empty string would destroy ciphertext the old
      // key could still recover, and re-stamping the key id would erase the
      // evidence that anything had ever been there. Carry it forward instead,
      // untouched, unless the caller explicitly set or cleared it.
      let carriedUnreadable = false;
      for (const f of SECRET_FIELDS) {
        const explicit = patch[f] !== undefined && String(patch[f]).trim() !== "";
        const cleared = patch[f] === CLEAR_SECRET;
        const prior = String(priorRaw[f] ?? "");
        if (!explicit && !cleared && next[f] === "" && prior !== "") {
          encrypted[f] = prior;
          carriedUnreadable = true;
          continue;
        }
        encrypted[f] = await encryptSecret(next[f]);
      }
      // Only claim the current key id once everything really is under it.
      encrypted[KID] = carriedUnreadable
        ? String(priorRaw[KID] ?? (await masterKeyId()))
        : await masterKeyId();
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
  // A voice is no longer something every user has to go and buy: when the
  // deployment supplies one, only the model key is theirs to bring. Inference
  // still bills the caller, which is the part that actually costs money.
  const hasVoice = !!c.ttsKey || c.ttsProvider === "browser" || houseVoiceAvailable();
  return !!((c.mcpToken || c.composioKey) && c.llmKey && hasVoice);
}

/** What the browser is allowed to see: presence and a masked hint, never the key. */
export function maskCredentials(c: Credentials) {
  return {
    mcpUrl: c.mcpUrl,
    // Presence only — the token itself stays server-side like every secret.
    mcpConnected: !!c.mcpToken,
    llmProvider: c.llmProvider,
    llmModel: c.llmModel,
    llmBaseUrl: c.llmBaseUrl ?? "",
    ttsProvider: c.ttsProvider,
    ttsVoice: c.ttsVoice,
    ttsModel: c.ttsModel,
    ttsBaseUrl: c.ttsBaseUrl ?? "",
    composioKey: { set: !!c.composioKey, hint: maskSecret(c.composioKey) },
    llmKey: { set: !!c.llmKey, hint: maskSecret(c.llmKey) },
    ttsKey: { set: !!c.ttsKey, hint: maskSecret(c.ttsKey) },
    onboarded: isOnboarded(c),
    // Presence only — the deployment's key itself never leaves the server.
    houseVoice: houseVoiceAvailable(),
  };
}
