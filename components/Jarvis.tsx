"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Orb, { type OrbState } from "./Orb";
import { createSentenceStream } from "@/lib/sentences";
import { Speaker } from "@/lib/speaker";
import { Listener, speechSupported } from "@/lib/voice";

type Turn = { role: "user" | "assistant"; text: string };

type Health = {
  llm: { provider: string; model: string; ready: boolean };
  tts: { provider: string; ready: boolean; onDevice: boolean };
  integrations: boolean;
  memory: boolean;
};

export default function Jarvis() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState("");
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [started, setStarted] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [typed, setTyped] = useState("");

  const speakerRef = useRef<Speaker | null>(null);
  const listenerRef = useRef<Listener | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const busyRef = useRef(false);

  turnsRef.current = turns;

  const supported = useMemo(() => speechSupported(), []);

  /* ----------------------------- bootstrap ---------------------------- */

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  if (!speakerRef.current && typeof window !== "undefined") {
    speakerRef.current = new Speaker();
  }

  // Voice failures must be visible. Silently missing audio reads as "broken"
  // with no way to tell whether the model, the network, or a key is at fault.
  useEffect(() => {
    const speaker = speakerRef.current;
    if (speaker) speaker.onError = (m) => setVoiceError(m);
  }, []);

  const level = useCallback(() => speakerRef.current?.level() ?? 0, []);

  const orbState: OrbState = speaking
    ? "speaking"
    : thinking
      ? "thinking"
      : listening
        ? "listening"
        : "idle";

  /* ------------------------------ sending ----------------------------- */

  const send = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || busyRef.current) return;

    busyRef.current = true;
    setError("");
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
          } else if (ev.t === "status") {
            setStatus(ev.v);
            if (ev.v) setThinking(true);
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
      setThinking(false);
      setStatus("");
      abortRef.current = null;
      busyRef.current = false;

      if (assistant.trim()) {
        setTurns((prev) => [...prev, { role: "assistant", text: assistant.trim() }]);
      }
      setPartial("");
    }
  }, []);

  /* ------------------------------ barge-in ---------------------------- */

  /**
   * Rewrite history to what was actually heard. Without this the model
   * believes you heard the whole reply, and every later turn is subtly wrong.
   */
  const interrupt = useCallback(() => {
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

  useEffect(() => {
    const speaker = speakerRef.current;
    if (!speaker) return;
    return speaker.onSpeakingChange(setSpeaking);
  }, []);

  const beginSession = useCallback(() => {
    const speaker = speakerRef.current;
    speaker?.unlock();
    setStarted(true);

    if (!supported) return;

    const listener = new Listener({
      onFinal: (text) => {
        setInterim("");
        void send(text);
      },
      onInterim: setInterim,
      onBargeIn: interrupt,
      onStateChange: setListening,
      onError: setError,
    });

    listener.currentlySpeaking = () => speakerRef.current?.spokenText() ?? "";
    listener.isSpeaking = () => speakerRef.current?.isSpeaking ?? false;
    listener.bargeInEnabled = () => true;

    listenerRef.current = listener;
    listener.start();
  }, [interrupt, send, supported]);

  useEffect(() => {
    return () => {
      listenerRef.current?.stop();
      speakerRef.current?.stop();
    };
  }, []);

  /* -------------------------------- view ------------------------------ */

  const lastAssistant = partial || turns.filter((t) => t.role === "assistant").slice(-1)[0]?.text;
  const configIssue =
    health && !health.llm.ready
      ? "No model key configured yet."
      : health && !health.tts.ready
        ? "No voice key configured yet — JARVIS will use the on-device voice."
        : "";

  return (
    <main className="stage">
      <header className="topbar">
        <span className="wordmark">JARVIS</span>
        <nav>
          <Link href="/integrations">Integrations</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </header>

      <div className="orb-wrap" onClick={speaking ? interrupt : undefined}>
        <Orb state={orbState} level={level} />

        {!started && (
          <button className="ignition" onClick={beginSession}>
            <span>Wake JARVIS</span>
            <small>Audio needs a click before it can start</small>
          </button>
        )}
      </div>

      <section className="readout">
        {error && <p className="line error">{error}</p>}
        {voiceError && (
          <p className="line error">
            Voice: {voiceError} — using the on-device voice instead.
          </p>
        )}
        {configIssue && !error && <p className="line muted">{configIssue}</p>}

        {status && <p className="line status">{status}…</p>}
        {interim && <p className="line interim">{interim}</p>}

        {lastAssistant && !status && <p className="line said">{lastAssistant}</p>}

        {started && !supported && (
          <p className="line muted">
            This browser has no speech recognition — use Chrome for voice, or type below.
          </p>
        )}

        {started && speaking && <p className="line hint">Speak, or click the orb, to interrupt</p>}
      </section>

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
          placeholder="or type to JARVIS…"
          aria-label="Message JARVIS"
        />
        <button type="submit" disabled={!typed.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
