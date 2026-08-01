import { authConfigured, sessionFromRequest } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";
import { findTts } from "@/lib/providers/tts";
import { getSettings, kvEnabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets the UI say exactly what's missing instead of failing silently. */
export async function GET(req: Request) {
  const session = await sessionFromRequest(req);
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
    // Diagnostic only, and only for signed-in callers. Reports whether a
    // variable exists and how long it is — never any part of the value. Even
    // that much is configuration metadata, so it stays behind the session.
    env: session
      ? envReport([
          "COMPOSIO_API_KEY",
          "DATABASE_URL",
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "MOONSHOT_API_KEY",
          "FISH_API_KEY",
          "JARVIS_ALLOWED_EMAILS",
          "JARVIS_INVITE_CODE",
        ])
      : undefined,
  });
}

function envReport(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const raw = process.env[n];
    out[n] =
      raw === undefined
        ? "missing"
        : raw.trim().length === 0
          ? "EMPTY (defined, no value)"
          : `ok (${raw.trim().length} chars)`;
  }
  return out;
}
