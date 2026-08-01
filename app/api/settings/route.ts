import { LLM_PROVIDERS } from "@/lib/providers/llm";
import { ttsCatalogue } from "@/lib/providers/tts";
import { getSettings, maskSettings, saveSettings, type Settings } from "@/lib/store";
import { composioEnabled } from "@/lib/composio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  return Response.json({
    settings: maskSettings(settings),
    llmProviders: LLM_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      format: p.format,
      baseUrl: p.baseUrl,
      models: p.models,
      keyUrl: p.keyUrl,
      editableBaseUrl: !!p.editableBaseUrl,
      note: p.note ?? "",
    })),
    ttsProviders: ttsCatalogue(),
    composio: composioEnabled(),
  });
}

export async function POST(req: Request) {
  let patch: Partial<Settings>;
  try {
    patch = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Whitelist fields — never let the client write arbitrary keys into storage.
  const clean: Partial<Settings> = {};

  if (patch.llm) {
    clean.llm = {
      providerId: String(patch.llm.providerId ?? ""),
      model: String(patch.llm.model ?? ""),
      baseUrl: patch.llm.baseUrl ? String(patch.llm.baseUrl) : undefined,
      apiKey: patch.llm.apiKey ? String(patch.llm.apiKey) : undefined,
    };
  }

  if (patch.tts) {
    clean.tts = {
      providerId: String(patch.tts.providerId ?? ""),
      voiceId: String(patch.tts.voiceId ?? ""),
      model: patch.tts.model ? String(patch.tts.model) : undefined,
      baseUrl: patch.tts.baseUrl ? String(patch.tts.baseUrl) : undefined,
      apiKey: patch.tts.apiKey ? String(patch.tts.apiKey) : undefined,
    };
  }

  if (patch.prefs) {
    const v = patch.prefs.verbosity;
    clean.prefs = {
      userName: String(patch.prefs.userName ?? "sir").slice(0, 40),
      verbosity: v === "terse" || v === "detailed" ? v : "balanced",
      autoListen: !!patch.prefs.autoListen,
      bargeIn: !!patch.prefs.bargeIn,
    };
  }

  const saved = await saveSettings(clean);
  return Response.json({ settings: maskSettings(saved) });
}
