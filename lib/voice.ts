/**
 * Speech recognition via the Web Speech API.
 *
 * Chrome/Edge only — Safari (desktop and iOS) doesn't implement it, so the UI
 * always keeps a text input available rather than pretending otherwise.
 *
 * The design goal is full duplex: the microphone stays live while CARVIS
 * speaks. The recognizer hears the assistant's own voice through the
 * speakers, so everything here is about telling the user's words apart from
 * that echo — well enough to stop on a real interruption AND to answer the
 * words that did the interrupting, instead of making the user repeat them.
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
export function looksLikeEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false;
  const words = heard.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  const tail = spoken.toLowerCase().slice(-400);
  const matches = words.filter((w) => w.length > 3 && tail.includes(w)).length;
  return matches / words.length > 0.6;
}

/** "Stop" alone must interrupt — demanding two words of anyone mid-flow is absurd. */
const COMMANDS = /\b(stop|wait|pause|hold on|hang on|shut up|enough|quiet|never ?mind)\b/i;

/**
 * Is the *newest* speech a genuine interruption?
 *
 * The recognizer hears the assistant through the mic and grows one long
 * utterance out of it, so during a long reply the transcript is minutes of
 * echo with the user's words tacked on the end. Scoring the whole utterance
 * drowns the interruption in its own denominator — the longer the reply, the
 * harder to interrupt, which users experience as "it talks over me to the
 * finish". So: judge only the freshest few words.
 */
export function isRealInterruption(recent: string, spoken: string): boolean {
  const tail = spoken.toLowerCase().slice(-400);
  const words = recent.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  // Two-plus substantial words the assistant did not just say…
  const nonEcho = words.filter((w) => w.length > 3 && !tail.includes(w));
  if (nonEcho.length >= 2) return true;

  // …or a single command word — unless the assistant itself just said it.
  // Whole-word match only: "I stopped the sync" must not make the user's
  // "stop" uninterruptable.
  const cmd = COMMANDS.exec(recent.toLowerCase());
  if (!cmd) return false;
  return !new RegExp(`\\b${cmd[1].replace(/ /g, "\\s+")}\\b`).test(tail);
}

const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/** Words that end a reply without being a new request in themselves. */
const COMMAND_WORDS = new Set([
  "stop", "wait", "pause", "hold", "hang", "on", "up", "shut",
  "enough", "quiet", "never", "mind", "nevermind", "cancel",
]);
/** Padding that can surround a command without changing what it is. */
const POLITE = new Set([
  "ok", "okay", "carvis", "jarvis", "please", "now", "just",
  "no", "oh", "hey", "that", "it",
]);

/**
 * "Stop." / "okay hold on" / "stop stop stop stop stop" — an instruction to
 * shut up, not a message. These must never be forwarded to the model, which
 * would gamely answer them. No length cap: a frustrated repeat is still the
 * same instruction, and the every-word check bounds it anyway.
 */
export function isBareCommand(text: string): boolean {
  const words = text.split(/\s+/).map(bare).filter(Boolean);
  if (!words.length) return false;
  if (!words.some((w) => COMMAND_WORDS.has(w) && w.length > 2)) return false;
  return words.every((w) => COMMAND_WORDS.has(w) || POLITE.has(w));
}

/**
 * Mid-job acknowledgements — "ok", "got it", "nice" — are the user talking
 * WITH the assistant, not redirecting it. Swallowing them beats cancelling a
 * live Salesforce query because someone reacted to a progress line.
 */
const ACKS = new Set([
  "ok", "okay", "cool", "yes", "yeah", "yep", "sure", "right", "alright",
  "fine", "nice", "great", "good", "perfect", "thanks", "thank", "you",
  "got", "it", "gotcha", "mhm", "mm", "hmm", "uh", "huh", "oh", "i", "see",
  "sounds", "understood", "cheers",
]);
export function isBackchannel(text: string): boolean {
  const words = text.split(/\s+/).map(bare).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => ACKS.has(w));
}

/**
 * Length of the contiguous echo prefix: how many leading words are exact
 * words the assistant just said. Echo transcribes near-verbatim, so exact
 * matching is right — substring tests ("cancel" inside "cancelled") ate the
 * user's verb. The run stops at the first word the assistant didn't say;
 * when in doubt this errs toward keeping words, because a little leaked echo
 * confuses the model far less than a missing verb.
 */
function echoPrefixLen(words: string[], spoken: string): number {
  const tailWords = new Set(
    spoken.toLowerCase().slice(-400).split(/\s+/).map(bare).filter(Boolean),
  );
  let n = 0;
  while (n < words.length && tailWords.has(bare(words[n]))) n++;
  return n;
}

/**
 * The user's own words at the end of a polluted utterance: everything after
 * the contiguous run of words the assistant just said.
 */
export function extractUserTail(live: string, spoken: string): string {
  const words = live.split(/\s+/).filter(Boolean);
  return words.slice(echoPrefixLen(words, spoken)).join(" ");
}

/**
 * Recover the user's words from a barged utterance. Two independent
 * estimates of where the echo ends — the word index recorded at barge time,
 * and the contiguous echo prefix of the final text — and the SMALLER wins.
 * The recognizer revises earlier words, so either can overshoot; taking the
 * minimum means a bad estimate leaks echo into the message instead of
 * silently amputating the user's sentence.
 */
export function stripBargePrefix(text: string, keepFrom: number, spoken: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const cut = Math.min(Math.max(0, keepFrom), echoPrefixLen(words, spoken));
  return words.slice(cut).join(" ");
}

export class Listener {
  private recognition: any = null;
  private wantActive = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last moment the recognizer reported audio during our own speech. */
  private lastHeardWhileSpeaking = 0;
  /** Word index where the user's speech starts in a barged utterance. */
  private bargeKeepFrom: number | null = null;
  /** What was being spoken at the barge — the echo to strip against. */
  private spokenAtBarge = "";

  /**
   * Everything recently audible from the speakers, asides included — the
   * reference echo is judged against. Must NOT be the answer transcript:
   * progress lines are audible too, and a reply's echo finalises a beat
   * after the next turn has reset that transcript.
   */
  currentlySpeaking: () => string = () => "";
  isSpeaking: () => boolean = () => false;
  bargeInEnabled: () => boolean = () => true;

  constructor(private handlers: Handlers) {}

  /**
   * Muting has to stop *capture*, not just delivery. The recognizer keeps
   * accumulating while muted and finalises a beat later, so gating the
   * callback alone leaked every muted word into the next message.
   */
  setMuted(muted: boolean): void {
    if (!this.wantActive) return;
    this.bargeKeepFrom = null;
    if (!muted) return;
    try {
      this.recognition?.abort();
    } catch {
      /* already gone */
    }
  }

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

      // A barge already in progress owns this utterance. Deliver it even if
      // CARVIS has started speaking again (a background job's "that's done"
      // can land inside the second it takes Chrome to finalise) — otherwise
      // the interrupting words are swallowed and must be repeated, which is
      // the exact failure full duplex exists to remove.
      if (this.bargeKeepFrom !== null) {
        if (final.trim()) {
          const said = stripBargePrefix(final.trim(), this.bargeKeepFrom, this.spokenAtBarge);
          this.bargeKeepFrom = null;
          // A bare "stop" already did its job in onBargeIn; and a fragment
          // that still reads as echo is a false positive, not a request.
          if (said && !isBareCommand(said) && !looksLikeEcho(said, this.currentlySpeaking())) {
            this.handlers.onFinal(said);
          }
        } else if (interim) {
          const said = stripBargePrefix(interim.trim(), this.bargeKeepFrom, this.spokenAtBarge);
          if (said) this.handlers.onInterim(said);
        }
        return;
      }

      if (this.isSpeaking() && live) {
        this.lastHeardWhileSpeaking = Date.now();
        // Only the newest words matter — everything before them is our own
        // voice accumulating in the recognizer's utterance.
        const words = live.split(/\s+/).filter(Boolean);
        const recent = words.slice(-8).join(" ");
        if (this.bargeInEnabled() && isRealInterruption(recent, this.currentlySpeaking())) {
          // Full duplex: remember where the user's words start and keep the
          // recognizer running — the rest of their sentence lands in this
          // same utterance and is answered once it finalises. (The abort()
          // that used to live here made interruption work, but it ate the
          // interruption itself and the user had to say it all again.)
          this.spokenAtBarge = this.currentlySpeaking();
          const frag = extractUserTail(live, this.spokenAtBarge);
          const fragLen = frag ? frag.split(/\s+/).length : 0;
          this.bargeKeepFrom = Math.max(0, words.length - fragLen);
          this.handlers.onBargeIn();
        }
        // Nothing heard DURING speech becomes input directly; a barge is
        // delivered by the block above, stripped of echo.
        return;
      }

      if (interim) this.handlers.onInterim(interim.trim());
      if (final.trim()) {
        // The recognizer often finalises its echo-filled utterance a beat
        // AFTER the audio ends. Without this, the assistant hears its own
        // reply as the user's next message and answers itself.
        const justStopped = Date.now() - this.lastHeardWhileSpeaking < 1500;
        if (justStopped && looksLikeEcho(final, this.currentlySpeaking())) return;
        this.handlers.onFinal(final.trim());
      }
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
      // A barge boundary indexes into the dead session's utterance — it
      // means nothing in the next one.
      this.bargeKeepFrom = null;
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
