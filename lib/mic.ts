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
 * Android Chrome will not share the microphone.
 *
 * An open getUserMedia stream starves SpeechRecognition of audio: the
 * recogniser starts, reports nothing, and the assistant simply never hears
 * you. Desktop Chrome shares the device happily, and iOS has no
 * SpeechRecognition at all — so Android is the only platform that has to
 * choose between animating the user's voice and actually hearing it.
 *
 * Hearing wins. On Android the orb reacts to output only, which costs a
 * flourish; the alternative cost voice input entirely, which is how this
 * shipped. It went unnoticed because the device matrix runs under Playwright,
 * where SpeechRecognition does not exist and the conflict cannot occur.
 */
export function micAnalyserBlocksSpeech(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const android = /android/i.test(navigator.userAgent);
  const hasSpeech = !!(
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );
  return android && hasSpeech;
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
