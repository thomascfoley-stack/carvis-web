import { allowedEmails, clearSession, inviteCode, sessionFromRequest } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";
import { dbEnabled, findUser, todayUsage } from "@/lib/db";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await sessionFromRequest(req);

  let usage: { messages: number; limit: number } | null = null;
  if (session && dbEnabled()) {
    try {
      const [today, user] = await Promise.all([
        todayUsage(session.email),
        findUser(session.email),
      ]);
      usage = { messages: today.messages, limit: user?.daily_limit ?? 50 };
    } catch {
      /* usage is informational only */
    }
  }

  return Response.json({
    // Never leak the code itself — only whether one is required.
    inviteRequired: !!inviteCode(),
    allowlistRestricted: allowedEmails().length > 0,
    composio: composioEnabled(),
    database: dbEnabled(),
    email: session?.email ?? null,
    usage,
  });
}

export async function DELETE() {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSession() },
  });
}
