import { createConnectLink, composioEnabled } from "@/lib/composio";
import { createState, stateCookie } from "@/lib/auth";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Kicks off "Sign in with Google". Composio runs the OAuth dance; we mint a
 * signed state cookie first so the callback can prove it belongs to a flow
 * this server actually started.
 */
export async function GET(req: Request) {
  if (!composioEnabled()) {
    return redirectWithError(req, "Composio is not configured. Set COMPOSIO_API_KEY in Vercel.");
  }

  const origin = new URL(req.url).origin;
  const link = await createConnectLink("gmail", `${origin}/api/auth/callback`);

  if (!link.ok) return redirectWithError(req, link.error);

  return new Response(null, {
    status: 302,
    headers: {
      location: link.data.redirectUrl,
      "set-cookie": stateCookie(await createState(link.data.connectedAccountId)),
    },
  });
}

function redirectWithError(req: Request, message: string): Response {
  const url = new URL("/login", new URL(req.url).origin);
  url.searchParams.set("error", message.slice(0, 200));
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}
