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

export class Speaker {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;

  private queue: { text: string; job: Promise<AudioBuffer | null>; aside: boolean }[] = [];
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
  private playing: { text: string; startedAt: number; duration: number } | null = null;

  /** Set when the server tells us to use the on-device voice instead. */
  private useBrowserVoice = false;

  /**
   * Surfaced to the UI. A silent failure is the worst possible outcome here.
   * `fellBack` says whether the on-device voice took over, so the UI can stop
   * claiming a fallback that didn't happen.
   */
  onError: (message: string, fellBack: boolean) => void = () => {};

  /** Must be called from a user gesture — browsers block audio otherwise. */
  unlock(): void {
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
    if (this.ctx.state === "suspended") void this.ctx.resume();
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
   * `aside` marks something JARVIS says *about* the work rather than as part
   * of the answer — "still working on that". It is spoken but kept out of the
   * heard-transcript, so interrupting mid-progress doesn't rewrite the reply
   * to a status line.
   */
  enqueue(text: string, aside = false): void {
    const clean = text.trim();
    if (!clean) return;

    if (this.useBrowserVoice) {
      this.speakOnDevice(clean, aside);
      return;
    }
    if (!this.ctx) return;

    const gen = this.generation;

    const job = (async (): Promise<AudioBuffer | null> => {
      const ac = new AbortController();
      this.controllers.push(ac);
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: clean }),
          signal: ac.signal,
        });

        if (res.status === 409) {
          // Server is configured for the on-device voice.
          this.useBrowserVoice = true;
          this.speakOnDevice(clean, aside);
          return null;
        }

        if (!res.ok) {
          // Falling silent is the worst outcome: the user sees text appear and
          // hears nothing, with no clue why. Report it, then keep talking using
          // the on-device voice so the conversation still works.
          const detail = await res
            .json()
            .then((d) => d?.error ?? `voice provider error ${res.status}`)
            .catch(() => `voice provider error ${res.status}`);
          this.onError(String(detail), true);
          this.useBrowserVoice = true;
          this.speakOnDevice(clean, aside);
          return null;
        }

        const bytes = await res.arrayBuffer();
        if (gen !== this.generation || !this.ctx) return null;

        try {
          return await this.ctx.decodeAudioData(bytes);
        } catch {
          // Provider returned 200 but not decodable audio (an HTML error page,
          // or a format this browser can't handle).
          this.onError("The voice provider returned audio this browser can't play.", true);
          this.useBrowserVoice = true;
          this.speakOnDevice(clean, aside);
          return null;
        }
      } catch (e) {
        // Interrupting cancels every queued request. That is the feature
        // working, not the voice breaking — say nothing.
        if (isAbort(e) || gen !== this.generation) return null;
        this.onError(`Could not reach the voice service: ${String(e).slice(0, 120)}`, false);
        return null;
      } finally {
        this.controllers = this.controllers.filter((c) => c !== ac);
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
        const buf = await head.job;
        this.queue.shift();
        if (gen !== this.generation) break;
        if (!buf || !this.ctx || !this.analyser) continue;

        this.setSpeaking(true);
        await new Promise<void>((resolve) => {
          const src = this.ctx!.createBufferSource();
          src.buffer = buf;
          src.connect(this.analyser!);
          src.onended = () => {
            if (this.current === src) this.current = null;
            resolve();
          };
          this.playing = {
            text: head.text,
            startedAt: this.ctx!.currentTime,
            duration: buf.duration,
          };
          this.current = src;
          src.start();
        });

        if (gen === this.generation) {
          if (!head.aside) this.spoken.push(head.text);
          this.playing = null;
        }
      }
    } finally {
      this.draining = false;
      if (gen === this.generation && !this.queue.length) {
        this.setSpeaking(false);
        this.playing = null;
      }
    }
  }

  /** Free, zero-latency, on-device voice. Robotic, but always available. */
  private speakOnDevice(text: string, aside = false): void {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.pitch = 0.9;

    const voices = window.speechSynthesis.getVoices();
    const british = voices.find(
      (v) => /en-GB/i.test(v.lang) && /daniel|arthur|male/i.test(v.name),
    );
    if (british) utter.voice = british;

    utter.onstart = () => this.setSpeaking(true);
    utter.onend = () => {
      if (!aside) this.spoken.push(text);
      if (!window.speechSynthesis.speaking) this.setSpeaking(false);
    };

    window.speechSynthesis.speak(utter);
  }

  /**
   * What the user actually heard — completed chunks plus a word-proportional
   * slice of whatever was mid-sentence when they interrupted.
   */
  spokenText(): string {
    const parts = [...this.spoken];

    if (this.playing && this.ctx) {
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
    this.generation++;
    this.queue = [];
    for (const c of this.controllers) c.abort();
    this.controllers = [];

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
