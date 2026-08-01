/**
 * Envelope encryption for per-user credentials.
 *
 * Users now supply their own Composio, model and voice keys. Those live in
 * Neon, which means they must not be readable by anyone who gets a look at the
 * database — a dump, a support query, a misconfigured read replica. AES-GCM
 * with a server-held master key keeps the ciphertext useless on its own.
 *
 * Web Crypto only, so this runs on both runtimes.
 */

const MASTER = (
  process.env.JARVIS_ENCRYPTION_KEY ||
  process.env.JARVIS_AUTH_SECRET ||
  process.env.COMPOSIO_API_KEY ||
  ""
).trim();

export const encryptionConfigured = () => MASTER.length >= 16;

let keyPromise: Promise<CryptoKey> | null = null;
let kidPromise: Promise<string> | null = null;

/**
 * A short, non-reversible stamp identifying *which* master key was in force.
 *
 * The master key falls back to COMPOSIO_API_KEY, and people rotate those. When
 * that happens every stored secret becomes undecryptable — and because
 * decryptSecret deliberately never throws, the failure looks exactly like
 * "the key was never saved". Stamping the row lets us tell the difference and
 * say so, instead of leaving someone re-entering keys that were saving fine.
 */
export function masterKeyId(): Promise<string> {
  if (!kidPromise) {
    kidPromise = (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`kid:${MASTER}`),
      );
      return Array.from(new Uint8Array(digest).slice(0, 6))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    })();
  }
  return kidPromise;
}

function masterKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      // Derive a fixed-length AES key from whatever secret we were given.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(MASTER));
      return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    })();
  }
  return keyPromise;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns `v1.<iv>.<ciphertext>`, both base64. */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  if (!encryptionConfigured()) {
    throw new Error("No encryption key configured; refusing to store a credential in the clear.");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await masterKey(),
    new TextEncoder().encode(plaintext),
  );

  return `v1.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  if (!stored) return "";
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return "";

  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(parts[1]) },
      await masterKey(),
      unb64(parts[2]),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong master key, or tampered ciphertext. Never throw into a request
    // path — an unreadable credential is simply an absent one.
    return "";
  }
}

/** For display. Never send a full key to the browser, even the user's own. */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
