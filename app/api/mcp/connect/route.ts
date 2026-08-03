import { sealTicket, sessionFromRequest } from "@/lib/auth";
import { loadCredentials } from "@/lib/credentials";
import { discover, pkcePair, registerClient } from "@/lib/mcpauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "carvis_mcp_state";

const back = (origin: string, err?: string) =>
  Response.redirect(
    `${origin}/setup${err ? `?mcp_error=${encodeURIComponent(err.slice(0, 140))}` : ""}`,
    302,
  );

/**
 * Starts the MCP OAuth dance for the user's saved endpoint. Everything the
 * callback will need — PKCE verifier, client id, token endpoint, nonce —
 * travels in a signed ten-minute cookie, never in the URL.
 */
export async function GET(req: Request) {
  const session = await sessionFromRequest(req);
  const origin = new URL(req.url).origin;
  if (!session) return back(origin, "Sign in first.");

  const creds = await loadCredentials(session.email);
  if (!creds.mcpUrl) return back(origin, "Save your MCP URL first, then connect.");

  const found = await discover(creds.mcpUrl);
  if ("error" in found) return back(origin, found.error);

  const redirectUri = `${origin}/api/mcp/callback`;
  const clientId = await registerClient(found.registrationEndpoint, redirectUri);
  if (!clientId) return back(origin, "The authorization server refused to register this app.");

  const { verifier, challenge } = await pkcePair();
  const nonce = crypto.randomUUID();

  const ticket = await sealTicket(
    {
      n: nonce,
      v: verifier,
      c: clientId,
      t: found.tokenEndpoint,
      r: creds.mcpUrl,
      e: session.email,
    },
    600,
  );

  const authorize = new URL(found.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", nonce);
  authorize.searchParams.set("scope", "openid profile email offline_access");
  authorize.searchParams.set("resource", creds.mcpUrl);

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": `${STATE_COOKIE}=${ticket}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    },
  });
}
