import { sessionFromRequest } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";
import { isOnboarded, loadCredentials } from "@/lib/credentials";
import { encryptionConfigured } from "@/lib/crypto";
import { dbEnabled } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment health, plus — for a signed-in caller — whether *their* own keys
 * are in place. Nothing here reveals a value, only presence.
 */
export async function GET(req: Request) {
  const session = await sessionFromRequest(req);

  const base = {
    // This deployment's Composio key brokers Google sign-in only. It grants
    // no access to any user's data; integrations use each user's own endpoint.
    signInBroker: composioEnabled(),
    database: dbEnabled(),
    encryption: encryptionConfigured(),
  };

  if (!session) return Response.json({ ...base, signedIn: false });

  const creds = await loadCredentials(session.email);
  return Response.json({
    ...base,
    signedIn: true,
    email: session.email,
    onboarded: isOnboarded(creds),
    mcp: !!(creds.mcpUrl && creds.composioKey),
    model: { provider: creds.llmProvider, model: creds.llmModel, ready: !!creds.llmKey },
    voice: { provider: creds.ttsProvider, ready: !!creds.ttsKey },
  });
}
