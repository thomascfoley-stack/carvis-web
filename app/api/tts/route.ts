import { sessionFromRequest } from "@/lib/auth";
import { addTtsChars, dbEnabled } from "@/lib/db";
import { synthesize } from "@/lib/providers/tts";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Voice proxy.
 *
 * Called once per *sentence* rather than once per reply, so the first sentence
 * can already be speaking while the rest of the answer is still generating.
 * Keeping provider keys server-side is the other reason this exists.
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

  // Metered but not blocked: cutting audio mid-reply is a worse failure than
  // a slightly over-quota day, and the message cap already bounds the volume.
  if (dbEnabled()) {
    void addTtsChars(session.email, text.length).catch(() => undefined);
  }

  const settings = await getSettings();
  const result = await synthesize(text, settings.tts, req.signal);

  if (!result.ok) {
    // Signals the client to fall back to the on-device Web Speech voice.
    const status = result.error === "browser-tts" ? 409 : 502;
    return Response.json({ error: result.error }, { status });
  }

  return new Response(result.audio, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
