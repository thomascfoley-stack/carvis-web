import { authConfigured } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";
import { findTts } from "@/lib/providers/tts";
import { getSettings, kvEnabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets the UI say exactly what's missing instead of failing silently. */
export async function GET() {
  const s = await getSettings();
  const tts = findTts(s.tts.providerId);

  return Response.json({
    llm: { provider: s.llm.providerId, model: s.llm.model, ready: !!s.llm.apiKey },
    tts: {
      provider: s.tts.providerId,
      ready: tts.needsKey ? !!s.tts.apiKey : true,
      onDevice: tts.id === "browser",
    },
    integrations: composioEnabled(),
    memory: kvEnabled(),
    authEnforced: authConfigured(),
  });
}
