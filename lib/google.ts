/**
 * Google OAuth 2.0 / OpenID Connect — the real thing.
 *
 * Login no longer depends on Composio. Composio is an integrations broker, not
 * an identity provider; routing sign-in through it meant nobody could log in
 * until an unrelated API key was set. Identity now comes from Google directly,
 * and Composio is used only to connect apps once you're already in.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const env = (n: string) => (process.env[n] || "").trim();

export const googleClientId = () => env("GOOGLE_CLIENT_ID");
export const googleClientSecret = () => env("GOOGLE_CLIENT_SECRET");
export const googleConfigured = () => !!(googleClientId() && googleClientSecret());

/** Only what we need to know who they are. Gmail/Calendar scopes come later, via Composio. */
const SCOPES = ["openid", "email", "profile"].join(" ");

export function authorizeUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  // Let people pick which Google account, rather than silently reusing one.
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");
  return url.toString();
}

export type GoogleIdentity = { email: string; name: string; picture: string; verified: boolean };

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ ok: true; identity: GoogleIdentity } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId(),
        client_secret: googleClientSecret(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Google: ${String(e).slice(0, 140)}` };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.id_token) {
    const detail = body?.error_description || body?.error || `HTTP ${res.status}`;
    return { ok: false, error: `Google rejected the sign-in: ${String(detail).slice(0, 180)}` };
  }

  const claims = decodeIdToken(body.id_token);
  if (!claims?.email) {
    return { ok: false, error: "Google returned no email address." };
  }

  // Signature verification is deliberately skipped: this token came straight
  // from Google's token endpoint over TLS in response to our own client
  // secret, not from the browser. Google documents that as trustworthy for the
  // authorization-code flow. (An implicit-flow token would need full JWKS
  // verification — we never accept one.)
  return {
    ok: true,
    identity: {
      email: String(claims.email).toLowerCase(),
      name: String(claims.name ?? ""),
      picture: String(claims.picture ?? ""),
      verified: claims.email_verified !== false,
    },
  };
}

function decodeIdToken(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const norm = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
    // atob yields latin-1; re-decode so non-ASCII names survive.
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
