/**
 * Sign in with Google, brokered by Composio.
 *
 * Composio isn't an identity provider, so identity here is: "completed a Google
 * OAuth flow that this server started, and the resulting Gmail profile is on
 * the allowlist". Two things make that sound rather than theatre —
 *
 *   1. A signed, short-lived state cookie issued before the redirect. Only this
 *      server can mint one, so /callback can't be driven directly.
 *   2. The connected account must actually be ACTIVE at Composio afterwards.
 *
 * Everything is Web Crypto so it runs on the Edge runtime, and therefore in
 * middleware.
 */

export const SESSION_COOKIE = "jarvis_session";
export const STATE_COOKIE = "jarvis_oauth_state";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE = 60 * 10; // 10 minutes

const env = (n: string) => (process.env[n] || "").trim();

/** Comma-separated Google addresses permitted to sign in. */
export function allowedEmails(): string[] {
  return env("JARVIS_ALLOWED_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Login is ALWAYS enforced. There is no "open until configured" mode.
 *
 * That matters more than it looks: Composio is single-tenant here, so a
 * stranger who clicked "Sign in with Google" would complete the flow against
 * the owner's connected account and be handed the owner's identity. An empty
 * allowlist must therefore deny everyone, never admit everyone.
 */
export const authConfigured = () => true;

export function isAllowed(email: string): boolean {
  const list = allowedEmails();
  if (!list.length) return false;
  return list.includes(email.trim().toLowerCase());
}

function secret(): string {
  return (
    env("JARVIS_AUTH_SECRET") ||
    env("COMPOSIO_API_KEY") ||
    "jarvis-insecure-development-secret"
  );
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}

/** Constant-time compare, so signature checks don't leak via timing. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function mint(data: Record<string, unknown>, ttlSec: number): Promise<string> {
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({ ...data, exp: Date.now() + ttlSec * 1000 })),
  );
  return `${payload}.${await sign(payload)}`;
}

async function open<T = any>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), await sign(payload))) return null;

  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof data?.exp !== "number" || data.exp < Date.now()) return null;
    return data as T;
  } catch {
    return null;
  }
}

/* ------------------------------ sessions ------------------------------ */

export const createSession = (email: string) => mint({ email }, SESSION_MAX_AGE);

export async function readSession(
  token: string | undefined,
): Promise<{ email: string } | null> {
  const data = await open<{ email?: string }>(token);
  return data?.email ? { email: data.email } : null;
}

export const verifySession = async (token: string | undefined) => !!(await readSession(token));

/* -------------------------- oauth state token ------------------------- */

export const createState = (connectedAccountId: string) =>
  mint({ caid: connectedAccountId }, STATE_MAX_AGE);

export async function readState(token: string | undefined): Promise<{ caid: string } | null> {
  const data = await open<{ caid?: string }>(token);
  return data?.caid ? { caid: data.caid } : null;
}

/* -------------------------------- cookies ----------------------------- */

function cookie(name: string, value: string, maxAge: number): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export const sessionCookie = (t: string) => cookie(SESSION_COOKIE, t, SESSION_MAX_AGE);
export const stateCookie = (t: string) => cookie(STATE_COOKIE, t, STATE_MAX_AGE);
export const clearSession = () => cookie(SESSION_COOKIE, "", 0);
export const clearState = () => cookie(STATE_COOKIE, "", 0);
