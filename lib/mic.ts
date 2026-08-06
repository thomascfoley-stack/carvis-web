/**
 * Microphone analyser.
 *
 * The Web Speech API gives us transcripts but no audio, so the visualisation
 * has nothing to react to while *you* speak. This opens a second stream purely
 * for frequency data — no recording, nothing leaves the browser.
 *
 * Echo cancellation is on so the assistant's own output doesn't feed back into
 * the cloud and make it look like you're talking when you aren't.
 */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let stream: MediaStream | null = null;
let starting = false;

/**
 * Never hold the microphone while the recogniser needs it.
 *
 * This analyser exists only to make the cloud react to your voice. It is a
 * flourish. Speech recognition is the product — and the two compete for the
 * same device.
 *
 * The first version of this restricted the rule to Android, on the theory that
 * desktop Chrome shares the microphone happily. It does not, reliably: a
 * starved recogniser does not report "device busy", it reports `network`,
 * because it fails while streaming audio to the speech service. That sends you
 * hunting a connection problem that was never there — which is exactly what
 * happened on the live site.
 *
 * So: wherever speech recognition exists, the recogniser gets the microphone
 * to itself and the cloud reacts to output only. Where it does not exist —
 * every browser on iOS — nothing is competing and the analyser runs, which is
 * also where it matters most, because typing is the only input.
 */
export function micAnalyserBlocksSpeech(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export async function startMicAnalyser(): Promise<AnalyserNode | null> {
  if (analyser) return analyser;
  if (starting || typeof navigator === "undefined" || !navigator.mediaDevices) return null;

  starting = true;
  try {
    // Construct the context BEFORE awaiting the permission prompt: on iOS a
    // context created outside the user-gesture call stack starts suspended
    // and stays that way.
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser); // deliberately NOT connected to destination
    return analyser;
  } catch {
    // Denied or unavailable: the orb simply falls back to output-only.
    return null;
  } finally {
    starting = false;
  }
}

export const getMicAnalyser = () => analyser;

export function stopMicAnalyser(): void {
  stream?.getTracks().forEach((t) => t.stop());
  void ctx?.close().catch(() => undefined);
  stream = null;
  ctx = null;
  analyser = null;
}
