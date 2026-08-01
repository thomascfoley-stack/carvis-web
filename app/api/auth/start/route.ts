import { checkInvite, createState, newNonce, stateCookie } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { authorizeUrl, googleConfigured } from "@/lib/google";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Begins Google sign-in.
 *
 * Note what this route no longer needs: Composio. Identity is Google's job;
 * Composio only comes in later, when you connect apps.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;

  if (!googleConfigured()) {
    return bounce(
      origin,
      "Google sign-in isn't set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel.",
    );
  }
  if (!dbEnabled()) {
    return bounce(origin, "No database configured. Set DATABASE_URL in Vercel.");
  }
  if (!checkInvite(url.searchParams.get("code") ?? "")) {
    return bounce(origin, "That invite code isn't right.");
  }

  const nonce = newNonce();

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl(`${origin}/api/auth/callback`, nonce),
      "set-cookie": stateCookie(await createState(nonce)),
    },
  });
}

function bounce(origin: string, message: string): Response {
  const url = new URL("/login", origin);
  url.searchParams.set("error", message.slice(0, 200));
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}
