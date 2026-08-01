import { sessionFromRequest } from "@/lib/auth";
import {
  loadCredentials,
  maskCredentials,
  saveCredentials,
  secretsUnreadable,
} from "@/lib/credentials";
import { encryptionConfigured } from "@/lib/crypto";
import { dbEnabled } from "@/lib/db";
import { forgetSession, listTools } from "@/lib/mcp";
import { forgetCatalogue } from "@/lib/tools";
import { loadPrefs, savePrefs } from "@/lib/prefs";
import { LLM_PROVIDERS } from "@/lib/providers/llm";
import { ttsCatalogue } from "@/lib/providers/tts";
import { redact } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  const [creds, prefs, stale] = await Promise.all([
    loadCredentials(session.email),
    loadPrefs(session.email),
    secretsUnreadable(session.email),
  ]);

  return Response.json({
    email: session.email,
    // Only ever presence + a masked hint. The full key never leaves the server,
    // not even back to the person who supplied it.
    credentials: maskCredentials(creds),
    prefs,
    llmProviders: LLM_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      keyUrl: p.keyUrl,
      editableBaseUrl: !!p.editableBaseUrl,
      note: p.note ?? "",
    })),
    ttsProviders: ttsCatalogue(),
    storage: { database: dbEnabled(), encryption: encryptionConfigured(), stale },
  });
}

export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  // The refusal exists because in-memory credentials silently vanish when a
  // serverless instance recycles — worse than an honest error. The escape
  // hatch is for the test harness, whose server is one long-lived process.
  const memoryStoreOk =
    (process.env.CARVIS_ALLOW_MEMORY_CREDENTIALS || "").trim() === "1";
  if (!dbEnabled() && !memoryStoreOk) {
    return Response.json(
      { error: "No database attached, so credentials can't be stored." },
      { status: 503 },
    );
  }
  if (!encryptionConfigured()) {
    return Response.json(
      { error: "No encryption key configured; refusing to store credentials in the clear." },
      { status: 503 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (body?.prefs) {
    await savePrefs(session.email, {
      userName: String(body.prefs.userName ?? "").slice(0, 40),
      verbosity: body.prefs.verbosity,
      bargeIn: body.prefs.bargeIn,
      autoListen: body.prefs.autoListen,
    });
  }

  const saved = await saveCredentials(session.email, {
    mcpUrl: body?.mcpUrl,
    composioKey: body?.composioKey,
    llmProvider: body?.llmProvider,
    llmModel: body?.llmModel,
    llmKey: body?.llmKey,
    llmBaseUrl: body?.llmBaseUrl,
    ttsProvider: body?.ttsProvider,
    ttsVoice: body?.ttsVoice,
    ttsModel: body?.ttsModel,
    ttsKey: body?.ttsKey,
    ttsBaseUrl: body?.ttsBaseUrl,
  });

  // The endpoint or key may have changed; drop the cached MCP handshake and
  // the cached tool catalogue so the next turn reflects the new credentials.
  if (saved.mcpUrl) {
    forgetSession(saved.mcpUrl);
    forgetCatalogue(saved.mcpUrl);
  }

  const prefs = await loadPrefs(session.email);
  return Response.json({ credentials: maskCredentials(saved), prefs });
}

/**
 * Live check against the user's own MCP endpoint. Far more useful than "saved"
 * — it tells them whether the thing actually works before they try to talk.
 */
export async function PUT(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  const creds = await loadCredentials(session.email);
  if (!creds.mcpUrl || !creds.composioKey) {
    return Response.json({ ok: false, error: "Add an MCP endpoint and key first." });
  }

  const res = await listTools(creds.mcpUrl, creds.composioKey, req.signal);
  if (!res.ok) return Response.json({ ok: false, error: redact(res.error) });

  return Response.json({
    ok: true,
    toolCount: res.data.length,
    sample: res.data.slice(0, 8).map((t) => t.name),
  });
}
