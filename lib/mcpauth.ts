import { CLEAR_SECRET, saveCredentials, type Credentials } from "./credentials";
import { redact } from "./redact";

/**
 * MCP authorization (the OAuth dance behind "just paste the URL").
 *
 * Composio's MCP endpoint — like every spec-compliant server — answers an
 * unauthenticated request with a 401 that says where its authorization server
 * lives. From there: fetch the server's metadata, register this deployment as
 * a public client (dynamic client registration), send the user through an
 * authorize redirect with PKCE, and swap the returned code for tokens. The
 * user never sees a key; the URL is the entire setup. That is the product:
 * a Composio tool for knowledge workers, not for people who collect API keys.
 *
 * Tokens are stored per user, encrypted, and refreshed just-in-time. Nothing
 * here is Composio-specific — any MCP server that implements the spec works.
 */

export type McpAuthServer = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
};

const insecureOk = () =>
  (process.env.CARVIS_ALLOW_INSECURE_BASEURL || process.env.JARVIS_ALLOW_INSECURE_BASEURL || "")
    .trim() === "1";

/**
 * Every URL discovered from the network must be https. The MCP endpoint is
 * user-supplied, so its metadata is untrusted input — an http authorization
 * server would put the user's tokens on the wire in the clear.
 */
function trustedUrl(raw: unknown): string {
  const s = String(raw ?? "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol === "https:") return s;
  return insecureOk() && u.protocol === "http:" ? s : "";
}

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 401 → protected-resource metadata → authorization-server metadata. */
export async function discover(mcpUrl: string): Promise<McpAuthServer | { error: string }> {
  let resourceMeta = "";
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      cache: "no-store",
    });
    const www = res.headers.get("www-authenticate") ?? "";
    resourceMeta = trustedUrl(/resource_metadata="([^"]+)"/.exec(www)?.[1]);
  } catch (e) {
    return { error: `Could not reach the MCP endpoint: ${redact(e).slice(0, 120)}` };
  }
  if (!resourceMeta) {
    // The spec's well-known fallback, for servers that omit the header.
    try {
      resourceMeta = new URL("/.well-known/oauth-protected-resource", mcpUrl).toString();
    } catch {
      return { error: "That MCP URL is not a valid URL." };
    }
  }

  const meta = await getJson(resourceMeta);
  const authServer = trustedUrl(meta?.authorization_servers?.[0]);
  if (!authServer) {
    return { error: "This MCP endpoint does not advertise an authorization server — it may need an API key instead." };
  }

  const asMeta =
    (await getJson(new URL("/.well-known/oauth-authorization-server", authServer).toString())) ??
    (await getJson(new URL("/.well-known/openid-configuration", authServer).toString()));

  const out: McpAuthServer = {
    authorizationEndpoint: trustedUrl(asMeta?.authorization_endpoint),
    tokenEndpoint: trustedUrl(asMeta?.token_endpoint),
    registrationEndpoint: trustedUrl(asMeta?.registration_endpoint),
  };
  if (!out.authorizationEndpoint || !out.tokenEndpoint) {
    return { error: "The authorization server published no usable endpoints." };
  }
  if (!out.registrationEndpoint) {
    return { error: "The authorization server does not accept new clients (no dynamic registration)." };
  }
  return out;
}

/** Public-client dynamic registration. Returns a client id, never a secret. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const d = await getJson(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "CARVIS",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  return String(d?.client_id ?? "");
}

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");

/** PKCE: the verifier stays in a signed cookie, only its hash goes upstream. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<TokenSet | { error: string }> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      cache: "no-store",
    });
  } catch (e) {
    return { error: `Token request failed: ${redact(e).slice(0, 120)}` };
  }
  const d = await res.json().catch(() => null);
  if (!res.ok || !d?.access_token) {
    return { error: redact(d?.error_description ?? d?.error ?? `token endpoint ${res.status}`).slice(0, 160) };
  }
  const ttl = Number(d.expires_in) > 0 ? Number(d.expires_in) : 3600;
  return {
    accessToken: String(d.access_token),
    refreshToken: String(d.refresh_token ?? ""),
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
  };
}

export const exchangeCode = (a: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  resource: string;
}) =>
  tokenRequest(a.tokenEndpoint, {
    grant_type: "authorization_code",
    code: a.code,
    redirect_uri: a.redirectUri,
    client_id: a.clientId,
    code_verifier: a.verifier,
    resource: a.resource,
  });

export const refreshTokens = (a: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource: string;
}) =>
  tokenRequest(a.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: a.refreshToken,
    client_id: a.clientId,
    resource: a.resource,
  });

/**
 * Hand back credentials whose MCP token is good for at least another minute,
 * refreshing and persisting on the way through. A refresh that fails clears
 * the token rather than letting every tool call 401 with a stale credential —
 * Setup then honestly shows "not connected" instead of pretending.
 */
export async function ensureFreshMcpAuth(email: string, creds: Credentials): Promise<Credentials> {
  if (!creds.mcpToken) return creds;

  const exp = Number(creds.mcpTokenExp || 0);
  if (exp - 60 > Math.floor(Date.now() / 1000)) return creds;

  if (creds.mcpRefresh && creds.mcpTokenUrl && creds.mcpClientId) {
    const t = await refreshTokens({
      tokenEndpoint: creds.mcpTokenUrl,
      clientId: creds.mcpClientId,
      refreshToken: creds.mcpRefresh,
      resource: creds.mcpUrl,
    });
    if (!("error" in t)) {
      return saveCredentials(email, {
        mcpToken: t.accessToken,
        mcpRefresh: t.refreshToken || creds.mcpRefresh,
        mcpTokenExp: String(t.expiresAt),
      });
    }
  }
  return saveCredentials(email, { mcpToken: CLEAR_SECRET, mcpRefresh: CLEAR_SECRET });
}
