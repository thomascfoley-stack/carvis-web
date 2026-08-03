import { openTicket, readCookie, sessionFromRequest } from "@/lib/auth";
import { saveCredentials } from "@/lib/credentials";
import { exchangeCode } from "@/lib/mcpauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "carvis_mcp_state";
const clearState = `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;

type Ticket = { n: string; v: string; c: string; t: string; r: string; e: string };

const back = (origin: string, query: string) =>
  new Response(null, {
    status: 302,
    headers: { location: `${origin}/setup?${query}`, "set-cookie": clearState },
  });

/**
 * The authorization server sends the user back here with a code. The signed
 * state cookie proves this browser started the flow (nonce), carries the PKCE
 * verifier, and pins the session — a code delivered to someone else's session
 * exchanges into nothing.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const err = (m: string) => back(origin, `mcp_error=${encodeURIComponent(m.slice(0, 140))}`);

  const session = await sessionFromRequest(req);
  if (!session) return err("Sign in first.");

  const ticket = await openTicket<Ticket>(readCookie(req, STATE_COOKIE));
  if (!ticket) return err("This connect attempt expired — try again.");
  if (ticket.e !== session.email) return err("This connect attempt belongs to a different session.");
  if (url.searchParams.get("state") !== ticket.n) return err("State mismatch — try again.");

  const upstream = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (upstream) return err(upstream);

  const code = url.searchParams.get("code") ?? "";
  if (!code) return err("The authorization server sent no code.");

  const tokens = await exchangeCode({
    tokenEndpoint: ticket.t,
    clientId: ticket.c,
    code,
    redirectUri: `${origin}/api/mcp/callback`,
    verifier: ticket.v,
    resource: ticket.r,
  });
  if ("error" in tokens) return err(tokens.error);

  await saveCredentials(session.email, {
    mcpToken: tokens.accessToken,
    mcpRefresh: tokens.refreshToken,
    mcpClientId: ticket.c,
    mcpTokenUrl: ticket.t,
    mcpTokenExp: String(tokens.expiresAt),
  });

  return back(origin, "mcp=connected");
}
