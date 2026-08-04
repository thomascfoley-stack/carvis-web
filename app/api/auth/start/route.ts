import { checkInvite, createState, newComposioUserId, stateCookie } from "@/lib/auth";
import { composioEnabled, createConnectLink } from "@/lib/composio";
import { dbEnabled } from "@/lib/db";
import { safeMessage } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begins "Sign in with Google", brokered by Composio.
 *
 * Composio owns the Google OAuth application (use_composio_managed_auth), so
 * this deployment holds exactly one auth secret — COMPOSIO_API_KEY. There is no
 * Google Cloud project to register and no client secret of ours anywhere.
 *
 * Multi-tenant: mint a brand-new Composio user id, run the OAuth against
 * *that* id, and carry it through the round trip in a signed state cookie.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;

  if (!composioEnabled()) {
    return bounce(origin, "Composio is not configured. Set COMPOSIO_API_KEY.");
  }
  if (!dbEnabled()) {
    return bounce(origin, "No database configured. Set DATABASE_URL.");
  }
  if (!checkInvite(url.searchParams.get("code") ?? "")) {
    return bounce(origin, "That invite code isn't right.");
  }

  // ALWAYS a fresh, unguessable id — never one derived from anything the
  // caller supplied.
  //
  // This route is unauthenticated by definition, so any caller-influenced
  // Composio id becomes an identity claim. An earlier version accepted an
  // `?email=` hint here and reused that user's existing Composio id "so a
  // returning user keeps their identity". That handed anyone who knew a
  // registered address a signed state cookie bound to the victim's tenant,
  // and /callback derives identity from exactly that id — an unauthenticated
  // account takeover requiring no interaction with Google at all.
  //
  // Returning users are re-attached to their original id in /callback, at
  // line "Returning users keep their original Composio id" — but only AFTER
  // the Gmail profile has proved who they are. Identity is established, then
  // the id is looked up; never the reverse.
  const composioUserId = newComposioUserId();

  const link = await createConnectLink("gmail", `${origin}/api/auth/callback`, composioUserId);
  if (!link.ok) return bounce(origin, link.error);

  return new Response(null, {
    status: 302,
    headers: {
      location: link.data.redirectUrl,
      "set-cookie": stateCookie(
        await createState(link.data.connectedAccountId, composioUserId),
      ),
    },
  });
}

function bounce(origin: string, message: string): Response {
  const url = new URL("/login", origin);
  url.searchParams.set("error", safeMessage(message));
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}
