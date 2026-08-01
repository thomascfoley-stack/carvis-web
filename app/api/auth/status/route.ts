import { SESSION_COOKIE, allowedEmails, authConfigured, clearSession, readSession } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export async function GET(req: Request) {
  const session = await readSession(readCookie(req, SESSION_COOKIE));
  return Response.json({
    enforced: authConfigured(),
    allowlistSize: allowedEmails().length,
    composio: composioEnabled(),
    email: session?.email ?? null,
  });
}

export async function DELETE() {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSession() },
  });
}
