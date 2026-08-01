import { checkInvite, createState, newComposioUserId, stateCookie } from "@/lib/auth";
import { composioEnabled, createConnectLink } from "@/lib/composio";
import { dbEnabled, findUser } from "@/lib/db";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Starts "Sign in with Google".
 *
 * Multi-tenant flow: mint a brand-new Composio user id, run the OAuth against
 * *that* id, and carry it through the round trip in a signed state cookie. The
 * callback then reads the resulting Gmail profile to learn who they are. A
 * returning user is matched by email and keeps their original id, so their
 * existing connections and memory follow them.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;

  if (!composioEnabled()) {
    return bounce(origin, "Composio is not configured. Set COMPOSIO_API_KEY in Vercel.");
  }
  if (!dbEnabled()) {
    return bounce(origin, "No database configured. Set DATABASE_URL in Vercel.");
  }

  if (!checkInvite(url.searchParams.get("code") ?? "")) {
    return bounce(origin, "That invite code isn't right.");
  }

  // A returning user keeps their existing Composio identity.
  const hint = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  let composioUserId = "";
  if (hint) {
    try {
      const existing = await findUser(hint);
      if (existing) composioUserId = existing.composio_user_id;
    } catch {
      /* fall through to a fresh id */
    }
  }
  if (!composioUserId) composioUserId = newComposioUserId();

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
  url.searchParams.set("error", message.slice(0, 200));
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}
