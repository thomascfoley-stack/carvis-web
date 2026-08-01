import { sessionFromRequest } from "@/lib/auth";
import { loadCredentials } from "@/lib/credentials";
import { dbEnabled, dbLoadVoices, dbSaveVoices } from "@/lib/db";
import { fetchVoices, findTts, type VoiceOption } from "@/lib/providers/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The voice catalogue for whichever provider the user has selected.
 *
 * Runs server-side so the provider key stays server-side — the browser gets
 * ids and names only. Results are cached in Postgres because this is a slow
 * third-party call on a settings page, and a voice library barely changes.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function providerFor(url: string, stored: string): string {
  // The picker has to work *before* Save, otherwise you cannot audition a
  // provider you haven't committed to yet.
  const asked = new URL(url).searchParams.get("provider");
  return asked || stored;
}

async function resolve(
  email: string,
  provider: string,
  refresh: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const creds = await loadCredentials(email);
  const descriptor = findTts(provider);

  // A key belongs to one provider. Auditioning a different one means we have
  // nothing to authenticate with, and saying so beats an opaque 401.
  const usable = provider === creds.ttsProvider ? creds.ttsKey : "";

  const base = {
    provider: descriptor.id,
    label: descriptor.label,
    voiceLabel: descriptor.voiceLabel,
    defaultVoice: descriptor.defaultVoice,
  };

  if (dbEnabled() && !refresh) {
    try {
      const hit = await dbLoadVoices(email, provider);
      if (hit && Array.isArray(hit.voices) && hit.voices.length) {
        const age = Date.now() - new Date(hit.fetchedAt).getTime();
        if (age < MAX_AGE_MS) {
          return Response.json({
            ...base,
            voices: hit.voices as VoiceOption[],
            cached: true,
            fetchedAt: hit.fetchedAt,
          });
        }
      }
    } catch {
      /* a cold cache is not a failure */
    }
  }

  const result = await fetchVoices(
    { providerId: provider, voiceId: "", model: "", apiKey: usable },
    signal,
  );

  if (!result.ok) {
    // Serve a stale list rather than nothing: an expired cache is far more
    // useful than an empty dropdown when the provider is briefly unreachable.
    if (dbEnabled()) {
      try {
        const hit = await dbLoadVoices(email, provider);
        if (hit && Array.isArray(hit.voices) && hit.voices.length) {
          return Response.json({
            ...base,
            voices: hit.voices as VoiceOption[],
            cached: true,
            stale: true,
            fetchedAt: hit.fetchedAt,
            error: result.error,
          });
        }
      } catch {
        /* nothing cached either */
      }
    }
    // Failure capture lives inside fetchVoices' graph node now.
    return Response.json({ ...base, voices: [], error: result.error });
  }

  if (dbEnabled() && result.live && result.voices.length) {
    try {
      await dbSaveVoices(email, provider, result.voices);
    } catch {
      /* caching is an optimisation, never a hard requirement */
    }
  }

  return Response.json({ ...base, voices: result.voices, cached: false, live: result.live });
}

export async function GET(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  const creds = await loadCredentials(session.email);
  return resolve(session.email, providerFor(req.url, creds.ttsProvider), false, req.signal);
}

/** Force a refetch — for when you've just cloned a voice and want it listed. */
export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  const creds = await loadCredentials(session.email);
  return resolve(session.email, providerFor(req.url, creds.ttsProvider), true, req.signal);
}
