import { sessionFromRequest } from "@/lib/auth";
import { loadCredentials } from "@/lib/credentials";
import { addTtsChars, dbEnabled, todayUsage } from "@/lib/db";
import { HOUSE_DAILY_CHAR_BUDGET, houseVoice } from "@/lib/housevoice";
import { isConfigState, synthesize } from "@/lib/providers/tts";

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

  // Auditioning a voice has to work before you commit to it, so the setup page
  // may override the voice and model. The provider and key always come from
  // stored credentials — a request can never nominate where the key is sent.
  const voiceId = String(body?.voice ?? "").trim().slice(0, 200) || creds.ttsVoice;
  const model = String(body?.model ?? "").trim().slice(0, 100) || creds.ttsModel;

  // Their own key wins: someone who has chosen a voice keeps it, and they are
  // spending their own money. The house voice only fills the gap.
  const ownKey = creds.ttsKey && creds.ttsProvider !== "browser";
  const house = ownKey ? null : houseVoice();

  // Explicitly choosing the browser provider is a choice, not a gap — honour
  // it even when a house voice exists.
  if (creds.ttsProvider === "browser") {
    return Response.json({ error: "browser-tts" }, { status: 409 });
  }

  // 409 tells the client to use the on-device voice rather than fail silently.
  if (!ownKey && !house) {
    return Response.json({ error: "browser-tts" }, { status: 409 });
  }

  // One key now serves everyone, so one account must not be able to spend the
  // whole bill. The budget applies ONLY to the house key — a user on their own
  // key is limited by their own provider, which is where that belongs.
  if (house && dbEnabled()) {
    try {
      const used = await todayUsage(session.email);
      if (used.tts_chars >= HOUSE_DAILY_CHAR_BUDGET) {
        return Response.json(
          { error: "Daily voice limit reached — add your own voice key in Setup to continue." },
          { status: 429 },
        );
      }
    } catch {
      /* usage accounting must never take the voice down */
    }
  }

  // Stored voice/model belong to the user's OWN provider — the default is
  // "onyx", an OpenAI id, which would be nonsense as a Fish reference. On the
  // house voice only an explicit override from this request is honoured.
  const audition = String(body?.voice ?? "").trim().slice(0, 200);
  const auditionModel = String(body?.model ?? "").trim().slice(0, 100);

  const result = await synthesize(
    text,
    house
      ? {
          providerId: house.providerId,
          voiceId: audition || house.voiceId,
          model: auditionModel || house.model,
          apiKey: house.apiKey,
          baseUrl: house.baseUrl,
        }
      : {
          providerId: creds.ttsProvider,
          voiceId,
          model,
          apiKey: creds.ttsKey,
          baseUrl: creds.ttsBaseUrl || undefined,
        },
    req.signal,
  );

  if (house && result.ok && dbEnabled()) {
    // Metered after success: a failed synthesis costs the user nothing.
    void addTtsChars(session.email, text.length).catch(() => undefined);
  }

  if (!result.ok) {
    // The client retries 429 and 5xx twice per sentence, so a permanently
    // invalid key must not be dressed up as a transient 502 — that turned one
    // bad key into three failed round trips for every sentence spoken, and
    // delayed the banner that explains it.
    const status = result.error === "browser-tts" ? 409 : isConfigState(result.error) ? 400 : 502;
    return Response.json({ error: result.error }, { status });
  }

  return new Response(result.audio, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
