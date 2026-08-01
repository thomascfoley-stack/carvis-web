import { sessionFromRequest } from "@/lib/auth";
import { loadCredentials } from "@/lib/credentials";
import { synthesize } from "@/lib/providers/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Voice proxy, billed to the caller's own key.
 *
 * Called once per *sentence* rather than once per reply, so the first sentence
 * can already be speaking while the rest of the answer is still generating.
 * The key never reaches the browser — that's the other reason this exists.
 */
export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const text = String(body?.text ?? "").trim().slice(0, 1500);
  if (!text) return new Response("No text", { status: 400 });

  const creds = await loadCredentials(session.email);

  // 409 tells the client to use the on-device voice rather than fail silently.
  if (!creds.ttsKey && creds.ttsProvider !== "browser") {
    return Response.json({ error: "browser-tts" }, { status: 409 });
  }

  const result = await synthesize(
    text,
    {
      providerId: creds.ttsProvider,
      voiceId: creds.ttsVoice,
      model: creds.ttsModel,
      apiKey: creds.ttsKey,
    },
    req.signal,
  );

  if (!result.ok) {
    const status = result.error === "browser-tts" ? 409 : 502;
    return Response.json({ error: result.error }, { status });
  }

  return new Response(result.audio, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
