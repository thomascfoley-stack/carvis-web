"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Orb, { type OrbState } from "./Orb";
import { createSentenceStream } from "@/lib/sentences";
import { Speaker } from "@/lib/speaker";
import { getMicAnalyser, startMicAnalyser, stopMicAnalyser } from "@/lib/mic";
import { Listener, speechSupported } from "@/lib/voice";

type Turn = { role: "user" | "assistant"; text: string };

export default function Carvis() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState("");
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [voiceError, setVoiceError] = useState<{ msg: string; fellBack: boolean } | null>(null);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [started, setStarted] = useState(false);
  const [typed, setTyped] = useState("");

  /**
   * Muting the microphone and silencing CARVIS are different actions and both
   * are needed. Mute stops *you* being heard — useful when someone walks into
   * the room — without cutting the reply short. Stop cuts the reply short.
   */
  const [muted, setMuted] = useState(false);

  /** Non-empty while a handed-off job is still running in the background. */
  const [backgroundJob, setBackgroundJob] = useState("");

  const speakerRef = useRef<Speaker | null>(null);
  const listenerRef = useRef<Listener | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const busyRef = useRef(false);
  const mutedRef = useRef(false);
  const detachedRef = useRef(false);
  const turnSeq = useRef(0);

  turnsRef.current = turns;
  mutedRef.current = muted;

  const supported = useMemo(() => speechSupported(), []);

  if (!speakerRef.current && typeof window !== "undefined") {
    speakerRef.current = new Speaker();
  }

  // Voice failures must be visible. Silently missing audio reads as "broken"
  // with no way to tell whether the model, the network, or a key is at fault.
  useEffect(() => {
    const speaker = speakerRef.current;
    if (speaker) speaker.onError = (msg, fellBack) => setVoiceError({ msg, fellBack });
  }, []);

  useEffect(() => {
    const speaker = speakerRef.current;
    if (!speaker) return;
    return speaker.onSpeakingChange(setSpeaking);
  }, []);

  const outputAnalyser = useCallback(() => speakerRef.current?.getAnalyser() ?? null, []);
  // Muting must also freeze the visual — a cloud reacting to a muted mic
  // would be actively misleading about whether you're being heard.
  const inputAnalyser = useCallback(() => (mutedRef.current ? null : getMicAnalyser()), []);

  const orbState: OrbState = speaking
    ? "speaking"
    : thinking
      ? "thinking"
      : listening && !muted
        ? "listening"
        : "idle";

  /* ------------------------------ sending ----------------------------- */

  const send = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || busyRef.current) return;

    const myTurn = ++turnSeq.current;
    busyRef.current = true;
    detachedRef.current = false;
    setError("");
    setVoiceError(null);
    setNote("");
    setInterim("");
    setPartial("");
    setThinking(true);

    const speaker = speakerRef.current;
    speaker?.resetTranscript();

    const history = [...turnsRef.current, { role: "user" as const, text: clean }];
    setTurns(history);

    const splitter = createSentenceStream();
    const controller = new AbortController();
    abortRef.current = controller;

    let assistant = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, text: t.text })),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          now: new Date().toString(),
        }),
        signal: controller.signal,
      });

      // 428: signed in, but hasn't supplied their own keys yet.
      if (res.status === 428) {
        window.location.href = "/setup";
        return;
      }

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `Server returned ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          if (!raw.trim()) continue;
          let ev: any;
          try {
            ev = JSON.parse(raw);
          } catch {
            continue;
          }

          if (ev.t === "text") {
            assistant += ev.v;
            setPartial(assistant);
            setThinking(false);
            // The moment a sentence is complete, start speaking it.
            for (const chunk of splitter.push(ev.v)) speaker?.enqueue(chunk);
          } else if (ev.t === "say") {
            // Progress spoken aloud. Deliberately not added to the transcript:
            // it is CARVIS talking about the work, not answering.
            speaker?.enqueue(String(ev.v), true);
          } else if (ev.t === "detach") {
            // The job is slow, so hand control back rather than hold the user
            // hostage. This request keeps running on its own connection — it
            // is no longer abortRef.current, so neither Stop nor the next
            // thing they say can kill it.
            detachedRef.current = true;
            abortRef.current = null;
            busyRef.current = false;
            setThinking(false);
            setStatus("");
            setBackgroundJob(ev.v?.label ?? "Working");
            if (ev.v?.say) speaker?.enqueue(String(ev.v.say), true);
          } else if (ev.t === "resumed") {
            setBackgroundJob("");
            if (ev.v?.say) speaker?.enqueue(String(ev.v.say), true);
          } else if (ev.t === "status") {
            setStatus(ev.v);
            if (ev.v) setThinking(true);
          } else if (ev.t === "note") {
            setNote(ev.v);
          } else if (ev.t === "error") {
            setError(ev.v);
          }
        }
      }

      const tail = splitter.flush();
      if (tail) speaker?.enqueue(tail);
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(String(e?.message ?? e));
    } finally {
      // A detached turn can finish *after* the user has started another one.
      // Only the turn that still owns the UI is allowed to reset it.
      if (turnSeq.current === myTurn) {
        setThinking(false);
        setStatus("");
        abortRef.current = null;
        busyRef.current = false;
        setPartial("");
      }
      setBackgroundJob("");

      if (assistant.trim()) {
        setTurns((prev) => [...prev, { role: "assistant", text: assistant.trim() }]);
      }
    }
  }, []);

  /* -------------------------------- stop ------------------------------ */

  /**
   * Cut CARVIS off mid-sentence and rewrite history to what was actually
   * heard. Without the rewrite the model believes you heard the whole reply,
   * and every later turn is subtly wrong.
   */
  const stopSpeaking = useCallback(() => {
    const speaker = speakerRef.current;
    if (!speaker) return;

    const heard = speaker.spokenText();
    speaker.stop();
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;

    setThinking(false);
    setStatus("");

    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") {
        last.text = heard ? `${heard} —` : "—";
      } else if (heard) {
        next.push({ role: "assistant", text: `${heard} —` });
      }
      return next;
    });
    setPartial("");
  }, []);

  /* ------------------------------ microphone -------------------------- */

  const beginSession = useCallback(() => {
    speakerRef.current?.unlock();
    void startMicAnalyser();
    setStarted(true);

    if (!supported) return;

    const listener = new Listener({
      onFinal: (text) => {
        // Muted means muted: nothing you say is transcribed or sent.
        if (mutedRef.current) return;
        setInterim("");
        void send(text);
      },
      onInterim: (t) => {
        if (!mutedRef.current) setInterim(t);
      },
      onBargeIn: () => {
        if (!mutedRef.current) stopSpeaking();
      },
      onStateChange: setListening,
      onError: setError,
    });

    listener.currentlySpeaking = () => speakerRef.current?.spokenText() ?? "";
    listener.isSpeaking = () => speakerRef.current?.isSpeaking ?? false;
    // While muted, your voice must never interrupt the reply.
    listener.bargeInEnabled = () => !mutedRef.current;

    listenerRef.current = listener;
    listener.start();
  }, [send, stopSpeaking, supported]);

  useEffect(() => {
    return () => {
      listenerRef.current?.stop();
      speakerRef.current?.stop();
      stopMicAnalyser();
    };
  }, []);

  // Coming back from the background (or a phone call) leaves the AudioContext
  // suspended on mobile. Resume it, or the next reply is silent.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && speakerRef.current?.ready) speakerRef.current.unlock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /* -------------------------------- view ------------------------------ */

  const lastAssistant = partial || turns.filter((t) => t.role === "assistant").slice(-1)[0]?.text;

  return (
    <main className="stage">
      <header className="topbar">
        <span className="wordmark">CARVIS</span>
        <nav>
          <Link href="/integrations">Integrations</Link>
          <Link href="/setup">Setup</Link>
        </nav>
      </header>

      <div className="orb-wrap">
        <Orb
          state={orbState}
          getOutputAnalyser={outputAnalyser}
          getInputAnalyser={inputAnalyser}
        />

        {!started && (
          <button className="ignition" onClick={beginSession}>
            <span>Wake CARVIS</span>
            <small>Audio needs a click before it can start</small>
          </button>
        )}
      </div>

      <section className="readout">
        {error && <p className="line error">{error}</p>}
        {voiceError && (
          <p className="line error">
            Voice: {voiceError.msg}
            {voiceError.fellBack ? " — using the on-device voice instead." : ""}
          </p>
        )}
        {note && <p className="line muted">{note}</p>}

        {status && <p className="line status">{status}…</p>}
        {interim && <p className="line interim">{interim}</p>}
        {lastAssistant && !status && <p className="line said">{lastAssistant}</p>}

        {started && !supported && (
          <p className="line muted">
            No speech recognition in this browser — on iPhone, type below (every iOS
            browser lacks it). On Android or desktop, Chrome has full voice.
          </p>
        )}
        {backgroundJob && (
          <p className="line hint">
            {backgroundJob} — still running in the background. Ask me something else meanwhile.
          </p>
        )}
        {muted && <p className="line hint">Microphone muted — CARVIS can’t hear you</p>}
      </section>

      {started && (
        <div className="controls">
          <button
            className={`control mute${muted ? " on" : ""}`}
            onClick={() => setMuted((m) => !m)}
            aria-pressed={muted}
            title="Mutes your microphone. Does not stop CARVIS speaking."
          >
            <span className="glyph">{muted ? "🔇" : "🎙"}</span>
            <span className="label">{muted ? "Unmute me" : "Mute me"}</span>
          </button>

          <button
            className="control stop"
            onClick={stopSpeaking}
            disabled={!speaking && !thinking}
            title="Stops CARVIS mid-sentence."
          >
            <span className="glyph">◼</span>
            <span className="label">Stop</span>
          </button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const text = typed;
          setTyped("");
          speakerRef.current?.unlock();
          setStarted(true);
          void send(text);
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="or type to CARVIS…"
          aria-label="Message CARVIS"
        />
        <button type="submit" disabled={!typed.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
