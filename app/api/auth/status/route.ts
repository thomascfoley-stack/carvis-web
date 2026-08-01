import { allowedEmails, clearSession, inviteCode, sessionFromRequest } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";
import { isOnboarded, loadCredentials } from "@/lib/credentials";
import { dbEnabled } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await sessionFromRequest(req);

  // No usage reporting: with bring-your-own-key there is no shared spend to
  // meter, so there is no quota to report.
  let onboarded = false;
  if (session) {
    try {
      onboarded = isOnboarded(await loadCredentials(session.email));
    } catch {
      /* informational only */
    }
  }

  return Response.json({
    // Never leak the code itself — only whether one is required.
    inviteRequired: !!inviteCode(),
    allowlistRestricted: allowedEmails().length > 0,
    // This deployment's Composio key brokers Google sign-in only.
    signInBroker: composioEnabled(),
    database: dbEnabled(),
    email: session?.email ?? null,
    onboarded,
  });
}

export async function DELETE() {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSession() },
  });
}
