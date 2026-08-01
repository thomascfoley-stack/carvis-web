/**
 * Sessions and access gates.
 *
 * Identity is established by Composio's Google OAuth broker (see
 * app/api/auth/*). This module signs the session and state cookies.
 */

export const SESSION_COOKIE = "jarvis_session";
export const STATE_COOKIE = "jarvis_oauth_state";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE = 60 * 10; // 10 minutes

const env = (n: string) => (process.env[n] || "").trim();

/** Optional hard allowlist of Google addresses. */
export function allowedEmails(): string[] {
  return env("JARVIS_ALLOWED_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Login is ALWAYS enforced. There is no "open until configured" mode. */
export const authConfigured = () => true;

/** Shared signup code. When unset, signup is open to any Google account. */
export const inviteCode = () => env("JARVIS_INVITE_CODE");

export function checkInvite(supplied: string): boolean {
  const expected = inviteCode();
  if (!expected) return true;
  return safeEqual(supplied.trim(), expected);
}

/**
 * Optional hard allowlist, layered on top of the invite code. Empty means
 * "anyone holding a valid invite code", which is the multi-tenant default.
 */
export function isAllowed(email: string): boolean {
  const list = allowedEmails();
  if (!list.length) return true;
  return list.includes(email.trim().toLowerCase());
}

/** Optional domain restriction, e.g. "composio.dev,example.com". */
export function domainAllowed(email: string): boolean {
  const domains = env("JARVIS_ALLOWED_DOMAINS")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!domains.length) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return domains.includes(email.slice(at + 1).toLowerCase());
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

/** Constant-time compare, so signature and invite checks don't leak via timing. */
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

export type Session = { email: string; cid: string };

/** `cid` is the caller's own Composio user id — the tenant isolation boundary. */
export const createSession = (email: string, composioUserId: string) =>
  mint({ email, cid: composioUserId }, SESSION_MAX_AGE);

export async function readSession(token: string | undefined): Promise<Session | null> {
  const data = await open<{ email?: string; cid?: string }>(token);
  return data?.email && data?.cid ? { email: data.email, cid: data.cid } : null;
}

export const verifySession = async (token: string | undefined) => !!(await readSession(token));

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export const sessionFromRequest = (req: Request) =>
  readSession(readCookie(req, SESSION_COOKIE));

/* -------------------------- oauth state token ------------------------- */

/**
 * Carries the freshly minted Composio user id through the OAuth round trip.
 * Signed, so /callback cannot be driven with an id we did not issue.
 */
export const createState = (connectedAccountId: string, composioUserId: string) =>
  mint({ caid: connectedAccountId, cid: composioUserId }, STATE_MAX_AGE);

export async function readState(
  token: string | undefined,
): Promise<{ caid: string; cid: string } | null> {
  const data = await open<{ caid?: string; cid?: string }>(token);
  return data?.caid && data?.cid ? { caid: data.caid, cid: data.cid } : null;
}

/** Opaque per-user Composio identity. Never derived from the email. */
export function newComposioUserId(): string {
  return `u_${crypto.randomUUID().replace(/-/g, "")}`;
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
