"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Orb, { type BranchAnchor, type OrbState } from "./Orb";
import { createSentenceStream } from "@/lib/sentences";
import { Speaker } from "@/lib/speaker";
import {
  getMicAnalyser,
  micAnalyserBlocksSpeech,
  primeMicPermission,
  startMicAnalyser,
  stopMicAnalyser,
} from "@/lib/mic";
import { Listener, isBackchannel, isBareCommand, speechSupported } from "@/lib/voice";
import { installGlobalReporter, reportClientFailure } from "@/lib/report";
import type { Snapshot } from "@/lib/snapshot";

/**
 * `turn` records which request produced this entry. A background turn can land
 * its answer while a newer turn is still speaking, so "the last assistant
 * entry" is not reliably the one being spoken — rewriting by position
 * overwrote the wrong answer with the wrong text.
 */
type Turn = { role: "user" | "assistant"; text: string; turn?: number };

export default function Carvis() {
  const [turns, setTurns] = useState<Turn[]>([]);
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

  /**
   * The branch a tool turn's result lives on. Set when the first tool fires,
   * cleared when the next task begins — that is the zoom-out. The card shows
   * the assistant's own consolidated answer, not the raw tool payload: the
   * consolidation contract already guarantees it fits a glance.
   */
  const [branch, setBranch] = useState<{ id: number; kind: string } | null>(null);
  const [branchText, setBranchText] = useState("");
  /**
   * The rows behind the answer. Speech and screen want opposite things: the
   * voice says "twelve unread, three matter" because reading twelve subjects
   * aloud is useless, while the eye takes in all twelve faster than any
   * sentence describing them. So the card shows the list and the voice keeps
   * consolidating.
   */
  const [card, setCard] = useState<Snapshot | null>(null);
  const branchCardRef = useRef<HTMLDivElement>(null);

  const speakerRef = useRef<Speaker | null>(null);
  const listenerRef = useRef<Listener | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const busyRef = useRef(false);
  const mutedRef = useRef(false);
  const detachedRef = useRef(false);
  const turnSeq = useRef(0);

  /**
   * Turn id → label for every job still running in the background. A single
   * string raced: the first job to finish cleared the banner for the others,
   * and a released turn's late detach stamped its label over a live one.
   */
  const bgJobs = useRef(new Map<number, string>());
  const syncBanner = useCallback(() => {
    const labels = [...bgJobs.current.values()];
    setBackgroundJob(labels.length ? labels[labels.length - 1] : "");
  }, []);

  turnsRef.current = turns;
  mutedRef.current = muted;

  // Muting has to stop the recognizer, not just ignore its callbacks —
  // otherwise an utterance captured while muted is delivered after unmute.
  useEffect(() => {
    listenerRef.current?.setMuted(muted);
  }, [muted]);

  const supported = useMemo(() => speechSupported(), []);

  if (!speakerRef.current && typeof window !== "undefined") {
    speakerRef.current = new Speaker();
  }

  // Anything the browser can see and the server cannot goes to the shared
  // failures table, so "what is broken" is one query rather than two.
  useEffect(() => installGlobalReporter(), []);

  // Voice failures must be visible. Silently missing audio reads as "broken"
  // with no way to tell whether the model, the network, or a key is at fault.
  useEffect(() => {
    const speaker = speakerRef.current;
    if (speaker) {
      speaker.onError = (msg, fellBack) => {
        setVoiceError({ msg, fellBack });
        reportClientFailure("speaker.tts", msg);
      };
    }
  }, []);

  useEffect(() => {
    const speaker = speakerRef.current;
    if (!speaker) return;
    return speaker.onSpeakingChange(setSpeaking);
  }, []);

  /**
   * The Orb reports the focused branch's screen position every frame; the
   * card follows via direct style writes — running this through React state
   * would re-render the whole component at 60Hz for a transform.
   */
  const onBranchAnchor = useCallback((a: BranchAnchor) => {
    const el = branchCardRef.current;
    if (!el) return;
    const wrap = el.parentElement;
    const w = wrap?.clientWidth ?? 0;
    const h = wrap?.clientHeight ?? 0;
    // Clamp inside the stage so the card never slides under the controls or
    // off a phone's edge while the cloud drifts.
    const x = Math.max(w * 0.22, Math.min(w * 0.78, a.x));
    const y = Math.max(h * 0.24, Math.min(h * 0.72, a.y));
    el.style.opacity = a.visible ? "1" : "0";
    el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${a.scale})`;
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

  /* -------------------------------- stop ------------------------------ */

  /**
   * Cut CARVIS off mid-sentence and rewrite history to what was actually
   * heard. Without the rewrite the model believes you heard the whole reply,
   * and every later turn is subtly wrong.
   */
  const stopSpeaking = useCallback(() => {
    const speaker = speakerRef.current;
    if (!speaker) return;

    // Only an answer being cut off needs the history rewrite. Silencing a
    // progress line or a background job's report truncates nothing the model
    // needs to know about — and rewriting then would stamp the *current*
    // spoken text over an unrelated, already-complete transcript entry.
    const cuttingAnswer = speaker.answerInFlight;
    const heard = speaker.spokenText();
    speaker.stop();
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;

    setThinking(false);
    setStatus("");

    if (cuttingAnswer) {
      const owner = turnSeq.current;
      setTurns((prev) => {
        const next = [...prev];
        const text = heard ? `${heard} —` : "—";
        // Rewrite the entry this turn produced, not whatever happens to be
        // last — and replace it rather than mutating a state object in place.
        let i = -1;
        for (let k = next.length - 1; k >= 0; k--) {
          if (next[k].role === "assistant" && next[k].turn === owner) {
            i = k;
            break;
          }
        }
        if (i >= 0) next[i] = { ...next[i], text };
        else if (heard) next.push({ role: "assistant", text, turn: owner });
        return next;
      });
    }
  }, []);

  /* ------------------------------ sending ----------------------------- */

  const send = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean) return;

    const speaker = speakerRef.current;

    // Full duplex: a new request never waits for the old one.
    if (busyRef.current) {
      // `answerInFlight`, not `isSpeaking`: a reply whose audio is still
      // being fetched is every bit as much an answer in progress.
      if (speaker?.answerInFlight) {
        // Redirecting mid-answer — cut the reply off, same as a spoken barge.
        stopSpeaking();
      } else {
        // Tool work in flight: release the turn to the background instead of
        // killing it. It keeps its connection and reports when it lands; only
        // the screen (and the Stop button) move on to the new request.
        busyRef.current = false;
        abortRef.current = null;
        bgJobs.current.set(turnSeq.current, "Your earlier request");
        syncBanner();
      }
    }

    const myTurn = ++turnSeq.current;
    /** This turn owns the screen until a newer one starts. A released turn
     *  keeps streaming in the background but may only touch the transcript. */
    const own = () => turnSeq.current === myTurn;

    busyRef.current = true;
    detachedRef.current = false;
    setError("");
    setVoiceError(null);
    setNote("");
    setInterim("");
    setThinking(true);

    // A new task is the zoom-out: the previous result's branch releases the
    // camera before a fresh branch can claim it.
    setBranch(null);
    setBranchText("");
    setCard(null);
    let branchActive = false;

    speaker?.resetTranscript();

    const history = [...turnsRef.current, { role: "user" as const, text: clean }];
    setTurns(history);

    const splitter = createSentenceStream();
    const controller = new AbortController();
    abortRef.current = controller;

    let assistant = "";
    /** Speech composed after this turn lost the screen — played as one
     *  consolidated report when the background job completes, never
     *  interleaved with the conversation that replaced it. */
    const held: string[] = [];
    let announced = false;
    let failed = false;

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
            // The moment a sentence is complete, start speaking it — unless
            // the turn has been released, in which case the sentences are
            // held and delivered together when the job finishes.
            for (const chunk of splitter.push(ev.v)) {
              if (own()) speaker?.enqueue(chunk);
              else held.push(chunk);
            }
            if (own()) {
              setThinking(false);
              // The result writes itself onto the branch as it is spoken.
              if (branchActive) setBranchText(assistant);
            }
          } else if (ev.t === "say") {
            // Progress spoken aloud. Deliberately not added to the transcript:
            // it is CARVIS talking about the work, not answering. A released
            // turn stays quiet — a background job muttering "still working"
            // over a new conversation is worse than silence.
            if (own()) speaker?.enqueue(String(ev.v), true);
          } else if (ev.t === "detach") {
            // The job is slow, so hand control back rather than hold the user
            // hostage. This request keeps running on its own connection — it
            // is no longer abortRef.current, so neither Stop nor the next
            // thing they say can kill it.
            if (own()) {
              detachedRef.current = true;
              abortRef.current = null;
              busyRef.current = false;
              setThinking(false);
              setStatus("");
              if (ev.v?.say) speaker?.enqueue(String(ev.v.say), true);
            }
            bgJobs.current.set(myTurn, ev.v?.label ?? "Working");
            syncBanner();
          } else if (ev.t === "resumed") {
            bgJobs.current.delete(myTurn);
            syncBanner();
            // The completion announcement is the one thing a background turn
            // is allowed to say — it is the whole point of delegating. It
            // waits for a gap if the user is mid-conversation.
            announced = true;
            if (ev.v?.say) {
              if (own()) speaker?.enqueue(String(ev.v.say), true);
              else held.unshift(String(ev.v.say));
            }
          } else if (ev.t === "status") {
            if (own()) {
              setStatus(ev.v);
              if (ev.v) setThinking(true);
              // First tool of the turn claims a branch; the camera starts its
              // glide while the tool is still working.
              if (ev.v && !branchActive) {
                branchActive = true;
                setBranch({ id: myTurn, kind: String(ev.v) });
              }
            }
          } else if (ev.t === "card") {
            // Rows arrive the moment the tool returns — well before the model
            // has finished deciding what to say about them.
            if (own()) setCard(ev.v as Snapshot);
          } else if (ev.t === "note") {
            if (own()) setNote(ev.v);
          } else if (ev.t === "error") {
            failed = true;
            setError(own() ? ev.v : `Your earlier request failed: ${ev.v}`);
            // A failed turn releases the camera — an error banner floating on
            // a brain branch would dignify the failure more than it deserves.
            if (own()) setBranch(null);
          }
        }
      }

      const tail = splitter.flush();
      if (tail) {
        if (own()) speaker?.enqueue(tail);
        else held.push(tail);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        failed = true;
        reportClientFailure("client.turn", String(e?.message ?? e));
        setError(own() ? String(e?.message ?? e) : `Your earlier request failed: ${String(e?.message ?? e)}`);
      }
    } finally {
      // A released or detached turn can finish *after* the user has started
      // another one. Only the turn that still owns the screen may reset it.
      if (own()) {
        setThinking(false);
        setStatus("");
        abortRef.current = null;
        busyRef.current = false;
          }
      bgJobs.current.delete(myTurn);
      syncBanner();

      // An interrupted turn must NOT append what it was about to say:
      // stopSpeaking has already rewritten the transcript to the words that
      // actually reached the user, and appending the full text behind that
      // would tell the model they heard sentences they never did.
      if (assistant.trim() && !controller.signal.aborted) {
        setTurns((prev) => [...prev, { role: "assistant", text: assistant.trim(), turn: myTurn }]);
      }

      // A released turn speaks its answer as one consolidated report — after
      // the live conversation reaches a gap, so it never wedges itself
      // between two sentences of the exchange that replaced it.
      if (!failed && !controller.signal.aborted && held.length) {
        await speaker?.whenIdle();
        // Asides: the report is already in the transcript as its own turn,
        // and the heard-prefix rewrite belongs to whatever is being said now.
        if (!announced) speaker?.enqueue("About your earlier request —", true);
        for (const chunk of held) speaker?.enqueue(chunk, true);
      }
    }
  }, [stopSpeaking, syncBanner]);

  /* ------------------------------ microphone -------------------------- */

  const beginSession = useCallback(async () => {
    speakerRef.current?.unlock();
    setStarted(true);

    if (!supported) {
      // No recogniser to starve, so the visualiser is free to have the device.
      void startMicAnalyser();
      return;
    }

    // Settle the permission BEFORE the recogniser starts, then release the
    // device. A recogniser that starts while permission is still unresolved
    // dies mid-stream and reports `network` — a connection error for what is
    // actually a permission problem, which is what made this so hard to see.
    const primed = await primeMicPermission();
    if (!primed.ok) {
      reportClientFailure("voice.permission", `mic unavailable: ${primed.detail}`);
      setError(
        primed.detail.startsWith("NotAllowed")
          ? "Microphone access was blocked. Allow it in your browser settings, then reload."
          : `Couldn't open the microphone (${primed.detail}). Type below instead.`,
      );
      return;
    }

    const listener = new Listener({
      onFinal: (text) => {
        // Muted means muted: nothing you say is transcribed or sent.
        if (mutedRef.current) return;
        setInterim("");
        // "Stop." is an instruction, not a message — never forwarded to the
        // model, which would gamely answer it.
        if (isBareCommand(text)) {
          stopSpeaking();
          return;
        }
        // Mid-job acknowledgements ("ok", "got it") are conversation grease,
        // not a redirect — swallowing them beats cancelling live work. A
        // detached job clears busyRef but is still very much in flight.
        const working = busyRef.current || detachedRef.current || bgJobs.current.size > 0;
        if (working && isBackchannel(text)) return;
        void send(text);
      },
      onInterim: (t) => {
        if (!mutedRef.current) setInterim(t);
      },
      onBargeIn: () => {
        if (mutedRef.current) return;
        const speaker = speakerRef.current;
        if (speaker && !speaker.answerInFlight) {
          // They talked over a progress line or a background report —
          // silence it and leave the work (and the transcript) alone.
          speaker.stop();
        } else {
          stopSpeaking();
        }
      },
      onStateChange: setListening,
      onError: setError,
      onReport: reportClientFailure,
    });

    // Echo is judged against everything recently audible — asides included,
    // and not wiped when a new turn starts — never the answer transcript.
    listener.currentlySpeaking = () => speakerRef.current?.audibleText() ?? "";
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
          focusId={branch?.id ?? null}
          onAnchor={onBranchAnchor}
        />

        {branch && (
          <div className="branch-card" ref={branchCardRef} aria-live="polite">
            <div className="branch-kind">{card?.kind ?? branch.kind}</div>
            {card ? (
              <ul className="branch-rows">
                {card.rows.map((r, i) => (
                  <li key={i} className={r.emphasis ? "row hot" : "row"}>
                    <span className="row-primary">{r.primary}</span>
                    {r.secondary && <span className="row-secondary">{r.secondary}</span>}
                    {r.meta && <span className="row-meta">{r.meta}</span>}
                  </li>
                ))}
                {card.more ? <li className="row more">and {card.more} more</li> : null}
              </ul>
            ) : (
              <div className="branch-text">{branchText || "Working…"}</div>
            )}
          </div>
        )}

        {!started && (
          <button className="ignition" onClick={() => void beginSession()}>
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
        {/* YOUR words stay: seeing what was heard is how you know it heard you
            right, and it is the one thing a voice interface genuinely needs to
            show. CARVIS's own words deliberately do NOT appear — reading a
            reply a beat before it is spoken spoils the delivery and turns a
            conversation into a transcript you race ahead of. It speaks; you
            listen. The full exchange is still kept in `turns` for the model's
            history, it is simply not put on screen. */}
        {interim && <p className="line interim">{interim}</p>}

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
