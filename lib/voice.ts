/**
 * Speech recognition via the Web Speech API.
 *
 * Chrome/Edge only — Safari (desktop and iOS) doesn't implement it, so the UI
 * always keeps a text input available rather than pretending otherwise.
 *
 * Barge-in is the subtle part. The microphone hears the assistant's own voice
 * through the speakers, so naive interrupt detection makes it cut itself off
 * constantly. We require a couple of real words that don't look like an echo of
 * what's currently being said.
 */

type Handlers = {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onBargeIn: () => void;
  onStateChange: (listening: boolean) => void;
  onError: (message: string) => void;
};

export function speechSupported(): boolean {
  if (typeof window === "undefined") return false;
  return !!(
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );
}

/** Rough overlap check: is this probably the assistant's own audio? */
function looksLikeEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false;
  const words = heard.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  const tail = spoken.toLowerCase().slice(-400);
  const matches = words.filter((w) => w.length > 3 && tail.includes(w)).length;
  return matches / words.length > 0.6;
}

export class Listener {
  private recognition: any = null;
  private wantActive = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Supplied by the app so echo detection can see what's being said. */
  currentlySpeaking: () => string = () => "";
  isSpeaking: () => boolean = () => false;
  bargeInEnabled: () => boolean = () => true;

  constructor(private handlers: Handlers) {}

  get supported(): boolean {
    return speechSupported();
  }

  start(): void {
    if (!this.supported) {
      this.handlers.onError(
        "No speech recognition here — on iPhone every browser lacks it, so type below. On Android or desktop, Chrome has it.",
      );
      return;
    }
    this.wantActive = true;
    this.spawn();
  }

  stop(): void {
    this.wantActive = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    this.handlers.onStateChange(false);
  }

  private spawn(): void {
    if (!this.wantActive) return;

    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-GB";
    rec.maxAlternatives = 1;

    rec.onstart = () => this.handlers.onStateChange(true);

    rec.onresult = (event: any) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final += text;
        else interim += text;
      }

      const live = (final || interim).trim();

      if (this.isSpeaking() && live) {
        const words = live.split(/\s+/).filter(Boolean);
        if (
          this.bargeInEnabled() &&
          words.length >= 2 &&
          !looksLikeEcho(live, this.currentlySpeaking())
        ) {
          this.handlers.onBargeIn();
        } else {
          // Echo of our own voice — ignore it entirely.
          return;
        }
      }

      if (interim) this.handlers.onInterim(interim.trim());
      if (final.trim()) this.handlers.onFinal(final.trim());
    };

    rec.onerror = (e: any) => {
      const err = e?.error ?? "unknown";
      if (err === "not-allowed" || err === "service-not-allowed") {
        this.wantActive = false;
        this.handlers.onError("Microphone access denied. Allow it in your browser settings.");
      } else if (err !== "no-speech" && err !== "aborted") {
        this.handlers.onError(`Microphone error: ${err}`);
      }
    };

    rec.onend = () => {
      this.handlers.onStateChange(false);
      // Chrome ends the session after a silence; restart to stay always-on.
      if (this.wantActive) {
        this.restartTimer = setTimeout(() => this.spawn(), 250);
      }
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch {
      // start() throws if a previous instance hasn't fully released yet.
      this.restartTimer = setTimeout(() => this.spawn(), 400);
    }
  }
}
