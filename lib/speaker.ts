/**
 * Ordered audio pipeline.
 *
 * Chunks are fetched concurrently (chunk three downloads while chunk one
 * plays) but played strictly in order. A generation counter makes barge-in
 * instant: bump it and every in-flight request is orphaned.
 *
 * It also tracks what was *actually heard*. When you interrupt halfway through
 * a reply, the conversation history has to be rewritten to the spoken prefix —
 * otherwise the model believes you heard sentences that never reached you, and
 * every following turn is subtly wrong.
 */

type Listener = (speaking: boolean) => void;

/**
 * Interrupting is a normal, frequent event, and it aborts every in-flight
 * request. Those rejections are not failures and must never reach the user.
 */
function isAbort(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "AbortError") return true;
  return /abort/i.test(String(err?.message ?? e ?? ""));
}

/** A deadline we imposed ourselves, not the user interrupting. */
function isTimeout(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  return err?.name === "TimeoutError" || /timed out/i.test(String(err?.message ?? ""));
}

/**
 * A rendered chunk: decoded audio, or an instruction to speak this one on the
 * device (the 409 handshake). Kept as data so it is played at the queue head
 * in order, rather than whenever its fetch happened to return.
 */
type Rendered = AudioBuffer | { device: string } | null;

const isDevice = (r: Rendered): r is { device: string } =>
  !!r && typeof (r as { device?: unknown }).device === "string";

/**
 * Past this a voice request is treated as failed. Without it a stalled request
 * holds a fetch slot and parks the drain forever, which presents as the app
 * going permanently mute for no visible reason.
 */
const FETCH_TIMEOUT_MS = 15_000;

export class Speaker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;

  private queue: { text: string; job: Promise<Rendered>; aside: boolean }[] = [];
  private draining = false;
  private current: AudioBufferSourceNode | null = null;
  private controllers: AbortController[] = [];

  private generation = 0;
  private listeners: Listener[] = [];
  private speaking = false;

  private levelValue = 0;
  private timeData: Uint8Array | null = null;

  /** Chunks that finished playing, plus how far into the current one we are. */
  private spoken: string[] = [];
  private playing: { text: string; startedAt: number; duration: number; aside: boolean } | null =
    null;

  /**
   * Everything that came out of the speakers recently, asides included —
   * the reference the microphone's echo detection compares against.
   *
   * Deliberately separate from `spoken`: that one is the *answer* transcript
   * (asides excluded, reset each turn) and using it for echo made progress
   * lines invisible, so CARVIS heard its own "still working on that" as an
   * interruption. This buffer is never reset by a new turn — the recognizer
   * finalises the previous reply's echo a beat after the next turn starts.
   */
  private audible: string[] = [];

  private remember(text: string): void {
    this.audible.push(text);
    let total = this.audible.join(" ").length;
    while (this.audible.length > 1 && total > 900) {
      total -= (this.audible.shift() ?? "").length + 1;
    }
  }

  /** What the microphone may be hearing back. Echo detection only. */
  audibleText(): string {
    const parts = [...this.audible];
    if (this.playing) parts.push(this.playing.text);
    if (this.deviceUtterance) parts.push(this.deviceUtterance.text);
    return parts.join(" ").slice(-900);
  }

  /** Set when the server tells us to use the on-device voice instead. */
  private useBrowserVoice = false;

  /**
   * Voice providers meter concurrency, not volume: firing every sentence's
   * fetch at once trips Fish's limit on a normal plan, and the reply lurches
   * between the real voice and the robot. Two in flight keeps the pipeline a
   * chunk ahead of playback without tripping anyone; a 429 that still slips
   * through is retried, not surrendered to.
   */
  private static readonly MAX_INFLIGHT = 2;
  private inflight = 0;
  private slotWaiters: (() => void)[] = [];

  private async acquireSlot(): Promise<void> {
    if (this.inflight < Speaker.MAX_INFLIGHT) {
      this.inflight++;
      return;
    }
    await new Promise<void>((r) => this.slotWaiters.push(r));
    this.inflight++;
  }

  private releaseSlot(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.slotWaiters.shift()?.();
  }

  /**
   * Surfaced to the UI. A silent failure is the worst possible outcome here.
   * `fellBack` says whether the on-device voice took over, so the UI can stop
   * claiming a fallback that didn't happen.
   */
  onError: (message: string, fellBack: boolean) => void = () => {};

  /** Utterances must be referenced until they finish — Safari and Chrome
   *  both garbage-collect in-flight SpeechSynthesisUtterances, which cuts the
   *  on-device voice off mid-sentence. */
  private liveUtterances = new Set<SpeechSynthesisUtterance>();

  /** Rough word timing for the on-device voice, so barge-in can still compute
   *  how much of a device-spoken chunk was actually heard. */
  private deviceUtterance: { text: string; startedAt: number; aside: boolean } | null = null;

  /** Must be called from a user gesture — browsers block audio otherwise. */
  unlock(): void {
    // iOS 16.4+: without this, Web Audio is muted by the ringer switch and
    // half of all "no sound on my iPhone" reports are just that.
    try {
      (navigator as unknown as { audioSession?: { type: string } }).audioSession!.type =
        "playback";
    } catch {
      /* not iOS, or too old */
    }

    // iOS also requires the FIRST speechSynthesis.speak() to happen inside a
    // user gesture. Prime it with silence now so the fallback voice is
    // allowed to talk later, from async contexts.
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.getVoices(); // kicks off the async voice load
        const primer = new SpeechSynthesisUtterance(" ");
        primer.volume = 0;
        window.speechSynthesis.speak(primer);
      } catch {
        /* harmless */
      }
    }

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.75;
      this.analyser.connect(this.ctx.destination);
      this.timeData = new Uint8Array(this.analyser.fftSize);
    }
    if (this.ctx.state !== "running") {
      void this.ctx
        .resume()
        .then(() => this.drain(this.generation))
        .catch(() => undefined);
    }
  }

  /**
   * Get the context actually running, or report that we couldn't.
   *
   * A suspended or interrupted context accepts `start()` and then never fires
   * `ended`, which parks the drain on a promise that can never settle. iOS
   * uses "interrupted" after a phone call or a Siri invocation, so testing
   * only for "suspended" misses the most common cause in the wild.
   */
  private async ensureRunning(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    // Read through a closure: control-flow narrowing would otherwise decide
    // the state cannot be "running" below, when resuming is the entire point.
    const running = () => (ctx.state as string) === "running";
    if (running()) return true;
    try {
      await ctx.resume();
    } catch {
      /* the state check below is the real answer */
    }
    return running();
  }

  /** Frequency data is far richer than RMS for driving a visualisation. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * An answer is being delivered — playing, queued, or still being fetched.
   *
   * `isSpeaking` is false for the whole fetch-and-decode window (Fish can
   * take a second), so keying "is CARVIS answering?" on it treated a reply
   * whose audio hadn't arrived yet as idle.
   */
  get answerInFlight(): boolean {
    if (this.deviceUtterance && !this.deviceUtterance.aside) return true;
    if (this.playing && !this.playing.aside) return true;
    return this.queue.some((q) => !q.aside);
  }

  /**
   * Resolves once nothing is playing or queued, or after `timeoutMs`. Lets a
   * background turn wait for a gap rather than wedging its report between
   * two sentences of the conversation that replaced it.
   */
  async whenIdle(timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!this.speaking && !this.queue.length) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  onSpeakingChange(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private setSpeaking(v: boolean) {
    if (this.speaking === v) return;
    this.speaking = v;
    for (const l of this.listeners) l(v);
  }

  /** Smoothed RMS of what's playing, 0..1. Drives the orb. */
  level(): number {
    if (!this.analyser || !this.timeData) {
      // The on-device voice gives us no signal to analyse, so fake a pulse.
      if (this.speaking) {
        this.levelValue = 0.35 + 0.25 * Math.sin(Date.now() / 90);
        return this.levelValue;
      }
      this.levelValue *= 0.9;
      return this.levelValue;
    }

    if (!this.speaking) {
      this.levelValue *= 0.9;
      return this.levelValue;
    }

    const buf = this.timeData as Uint8Array;
    (this.analyser as any).getByteTimeDomainData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const scaled = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);

    // Fast attack, slow release reads as far more alive than raw RMS.
    const k = scaled > this.levelValue ? 0.45 : 0.12;
    this.levelValue += (scaled - this.levelValue) * k;
    return this.levelValue;
  }

  /**
   * `aside` marks something CARVIS says *about* the work rather than as part
   * of the answer — "still working on that". It is spoken but kept out of the
   * heard-transcript, so interrupting mid-progress doesn't rewrite the reply
   * to a status line.
   */
  enqueue(text: string, aside = false): void {
    const clean = text.trim();
    if (!clean) return;

    if (this.useBrowserVoice) {
      void this.speakOnDevice(clean, aside);
      return;
    }
    if (!this.ctx) {
      // Silence with no explanation is indistinguishable from a broken app.
      this.onError("Audio isn't started yet — tap Wake CARVIS.", false);
      return;
    }

    const gen = this.generation;

    const job = (async (): Promise<Rendered> => {
      await this.acquireSlot();
      const ac = new AbortController();
      this.controllers.push(ac);
      // A request that never settles is worse than one that fails: it holds a
      // fetch slot forever AND parks the drain on an unresolvable promise, so
      // every later sentence queues up mute behind it. Mobile dead zones and
      // stalled invocations both do exactly this.
      const deadline = setTimeout(() => {
        try {
          ac.abort(new DOMException("Voice request timed out", "TimeoutError"));
        } catch {
          ac.abort();
        }
      }, FETCH_TIMEOUT_MS);
      try {
        if (gen !== this.generation) return null;

        for (let attempt = 0; ; attempt++) {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: clean }),
            signal: ac.signal,
          });

          if (res.status === 409) {
            // Server is configured for the on-device voice — the one case
            // where switching for the whole session is correct. Speaking here
            // would jump the queue, because responses arrive out of order;
            // hand it back so drain plays it at the head like anything else.
            this.useBrowserVoice = true;
            if (gen !== this.generation) return null;
            return { device: clean };
          }

          if (!res.ok) {
            // 429s and 5xx are weather, not climate — retry with backoff.
            const transient = res.status === 429 || res.status >= 500;
            if (transient && attempt < 2 && gen === this.generation) {
              await new Promise((r) => setTimeout(r, 650 * (attempt + 1)));
              continue;
            }
            // The chosen voice or nothing: the robot NEVER stands in for it.
            // This chunk stays silent — the words are on screen and the
            // banner says why — rather than lurching into the generic voice.
            const detail = await res
              .json()
              .then((d) => d?.error ?? `voice provider error ${res.status}`)
              .catch(() => `voice provider error ${res.status}`);
            this.onError(String(detail), false);
            return null;
          }

          const bytes = await res.arrayBuffer();
          if (gen !== this.generation || !this.ctx) return null;

          try {
            return await this.ctx.decodeAudioData(bytes);
          } catch {
            // Provider returned 200 but not decodable audio (an HTML error
            // page, or a format this browser can't handle).
            this.onError("The voice provider returned audio this browser can't play.", false);
            return null;
          }
        }
      } catch (e) {
        // Interrupting cancels every queued request. That is the feature
        // working, not the voice breaking — say nothing. A timeout aborts the
        // same way but is a genuine failure, so it must not be swallowed.
        if (isTimeout(e)) {
          this.onError("The voice service didn't respond in time.", false);
          return null;
        }
        if (isAbort(e) || gen !== this.generation) return null;
        this.onError(`Could not reach the voice service: ${String(e).slice(0, 120)}`, false);
        return null;
      } finally {
        clearTimeout(deadline);
        this.controllers = this.controllers.filter((c) => c !== ac);
        this.releaseSlot();
      }
    })();

    this.queue.push({ text: clean, job, aside });
    void this.drain(gen);
  }

  private async drain(gen: number): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.queue.length) {
        if (gen !== this.generation) break;

        const head = this.queue[0];
        const rendered = await head.job;
        // Check the generation BEFORE consuming: stop() replaces the queue,
        // so a shift here would eat the *next* turn's first sentence.
        if (gen !== this.generation) break;

        // A context that isn't running can never fire `ended`, so playing into
        // it parks this loop forever and every later sentence queues up behind
        // a promise that will never settle — silence for the rest of the
        // session. Leave the chunk queued, say why, and let unlock() resume.
        if (rendered && !(await this.ensureRunning())) {
          this.onError("Audio is paused — tap the page to resume.", false);
          break;
        }

        this.queue.shift();
        if (!rendered || !this.ctx || !this.analyser) continue;

        if (isDevice(rendered)) {
          // The 409 handshake, played in queue order like any other chunk.
          await this.speakOnDevice(rendered.device, head.aside);
          continue;
        }

        const buf = rendered;
        this.setSpeaking(true);
        await new Promise<void>((resolve) => {
          let settled = false;
          let guard: ReturnType<typeof setTimeout> | undefined;
          const src = this.ctx!.createBufferSource();
          const finish = () => {
            if (settled) return;
            settled = true;
            if (guard) clearTimeout(guard);
            if (this.current === src) this.current = null;
            resolve();
          };
          src.buffer = buf;
          src.connect(this.analyser!);
          src.onended = finish;
          this.playing = {
            text: head.text,
            startedAt: this.ctx!.currentTime,
            duration: buf.duration,
            aside: head.aside,
          };
          this.current = src;
          src.start();
          // Belt and braces: if `ended` never arrives — a mid-play suspend, a
          // device change — this releases the drain instead of wedging it.
          guard = setTimeout(finish, (buf.duration + 1) * 1000 + 500);
        });

        if (gen === this.generation) {
          if (!head.aside) this.spoken.push(head.text);
          this.remember(head.text);
          this.playing = null;
        }
      }
    } finally {
      this.draining = false;
      if (gen === this.generation && !this.queue.length) {
        this.setSpeaking(false);
        this.playing = null;
      }
      // A drain that outlived its generation was holding the `draining` flag,
      // so chunks enqueued meanwhile found no active drain and would sit
      // there mute. Hand the queue over to a drain that owns it.
      if (gen !== this.generation && this.queue.length) {
        void this.drain(this.generation);
      }
    }
  }

  /**
   * Free, zero-latency, on-device voice. Only ever reached when the user
   * *chose* the browser provider (the 409 handshake) — never as a stand-in
   * for a real voice that hiccuped.
   */
  private speakOnDevice(text: string, aside = false): Promise<void> {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      this.onError("This browser has no on-device voice — add a voice key in Setup.", false);
      return Promise.resolve();
    }

    return new Promise<void>((done) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.pitch = 0.9;

    const voices = window.speechSynthesis.getVoices();
    const british = voices.find(
      (v) => /en-GB/i.test(v.lang) && /daniel|arthur|male/i.test(v.name),
    );
    if (british) utter.voice = british;

    this.liveUtterances.add(utter);
    utter.onstart = () => {
      this.setSpeaking(true);
      // Tracked even for asides: the echo reference is what stops the
      // recogniser hearing a spoken progress line and calling it a barge.
      this.deviceUtterance = { text, startedAt: Date.now(), aside };
    };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.liveUtterances.delete(utter);
      if (!aside) this.spoken.push(text);
      this.deviceUtterance = null;
      this.remember(text);
      if (!window.speechSynthesis.speaking) this.setSpeaking(false);
      done();
    };
    utter.onend = finish;
    utter.onerror = finish;

    window.speechSynthesis.speak(utter);
    });
  }

  /**
   * What the user actually heard — completed chunks plus a word-proportional
   * slice of whatever was mid-sentence when they interrupted.
   */
  spokenText(): string {
    const parts = [...this.spoken];

    // On-device voice mid-utterance: estimate progress at ~3 words/second,
    // which is what both engines average at rate 1.05.
    if (this.deviceUtterance && !this.deviceUtterance.aside) {
      const words = this.deviceUtterance.text.split(/\s+/).filter(Boolean);
      const heardCount = Math.min(
        words.length,
        Math.max(1, Math.round(((Date.now() - this.deviceUtterance.startedAt) / 1000) * 3)),
      );
      parts.push(words.slice(0, heardCount).join(" "));
      return parts.join(" ").trim();
    }

    if (this.playing && !this.playing.aside && this.ctx) {
      const elapsed = this.ctx.currentTime - this.playing.startedAt;
      const fraction = Math.max(0, Math.min(1, elapsed / (this.playing.duration || 1)));
      const words = this.playing.text.split(/\s+/);
      const heard = words.slice(0, Math.max(1, Math.round(words.length * fraction)));
      if (heard.length) parts.push(heard.join(" "));
    }

    return parts.join(" ").trim();
  }

  /** Call when a new reply begins. */
  resetTranscript(): void {
    this.spoken = [];
    this.playing = null;
  }

  /** Barge-in: kill everything immediately. */
  stop(): void {
    // Whatever was mid-air still reached the microphone, so it stays in the
    // echo reference even though the user never heard the end of it.
    if (this.playing) this.remember(this.playing.text);
    if (this.deviceUtterance) this.remember(this.deviceUtterance.text);

    this.generation++;
    this.queue = [];
    this.deviceUtterance = null;
    // Cleared here too: drain's own cleanup is generation-gated, so after a
    // barge this stayed set and kept answerInFlight lying about what is live.
    this.playing = null;
    for (const c of this.controllers) c.abort();
    this.controllers = [];
    // Wake anything queued for a fetch slot; each will see the stale
    // generation and bail instead of fetching audio nobody wants.
    while (this.slotWaiters.length) this.slotWaiters.shift()?.();

    if (this.current) {
      try {
        this.current.stop();
      } catch {
        /* already stopped */
      }
      this.current = null;
    }

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    this.setSpeaking(false);
  }
}
