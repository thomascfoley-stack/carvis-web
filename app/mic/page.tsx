"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Microphone diagnostics.
 *
 * Two microphone fixes shipped on two different theories and neither held,
 * because every one of them was a guess: nobody can grant a permission or
 * speak into a headless browser, so the real failure was never observed. This
 * page observes it.
 *
 * Each check runs in isolation and reports what actually happened, so the
 * question stops being "is it the network?" and becomes "which of these five
 * things returned what". Crucially, step 4 runs a BARE recogniser with none of
 * the app's logic attached — if that works and CARVIS does not, the fault is
 * ours; if it fails too, the fault is the browser, the permission, or the
 * connection, and no amount of changing our code will help.
 */

type Line = { label: string; detail: string; ok: boolean | null };

export default function MicDiagnostics() {
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const recRef = useRef<any>(null);

  const add = useCallback(
    (label: string, detail: string, ok: boolean | null = null) =>
      setLines((l) => [...l, { label, detail, ok }]),
    [],
  );

  const run = useCallback(async () => {
    setLines([]);
    setRunning(true);

    // 1. Secure context — everything below is gated on it.
    add("Secure context", String(window.isSecureContext), window.isSecureContext);
    add("Origin", window.location.origin);
    add("Browser", navigator.userAgent.slice(0, 120));
    add("Online", String(navigator.onLine), navigator.onLine);

    // 2. Is the API even here?
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    add("SpeechRecognition present", Ctor ? "yes" : "NO", !!Ctor);

    // 3. Permission state, if the browser will tell us.
    try {
      const status = await (navigator.permissions as any)?.query({ name: "microphone" });
      add("Microphone permission", status?.state ?? "unknown", status?.state === "granted");
    } catch (e) {
      add("Microphone permission", `could not query: ${String(e).slice(0, 80)}`);
    }

    // 4. Can we open the device at all? This also triggers the prompt, which
    //    is worth doing explicitly rather than leaving to the recogniser.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      add("Microphone opens", `${track?.label || "unnamed device"}`, true);

      // Is there actually signal? A muted or wrong device reads as silence.
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let peak = 0;
      const started = Date.now();
      await new Promise<void>((done) => {
        const tick = () => {
          (an as any).getByteTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          if (Date.now() - started > 2500) return done();
          requestAnimationFrame(tick);
        };
        tick();
      });
      add(
        "Audio level (say something)",
        peak > 4 ? `signal detected (peak ${peak})` : `SILENT (peak ${peak})`,
        peak > 4,
      );
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    } catch (e: any) {
      add("Microphone opens", `FAILED: ${e?.name ?? ""} ${String(e?.message ?? e).slice(0, 100)}`, false);
    }

    // 5. A bare recogniser, with none of CARVIS's logic attached. This is the
    //    check that decides whether the bug is ours or the browser's.
    if (Ctor) {
      add("Bare recogniser", "starting — speak now…");
      await new Promise<void>((done) => {
        let settled = false;
        const finish = (label: string, detail: string, ok: boolean | null) => {
          if (settled) return;
          settled = true;
          add(label, detail, ok);
          done();
        };
        try {
          const rec = new Ctor();
          recRef.current = rec;
          rec.continuous = false;
          rec.interimResults = true;
          rec.lang = "en-GB";
          rec.onresult = (ev: any) =>
            finish("Bare recogniser", `HEARD: "${ev.results[0]?.[0]?.transcript ?? ""}"`, true);
          rec.onerror = (ev: any) =>
            finish("Bare recogniser", `ERROR: ${ev?.error ?? "unknown"}`, false);
          rec.onend = () => finish("Bare recogniser", "ended with no result", null);
          rec.start();
          setTimeout(() => {
            try {
              rec.stop();
            } catch {
              /* already done */
            }
          }, 6000);
        } catch (e: any) {
          finish("Bare recogniser", `THREW: ${String(e?.message ?? e).slice(0, 100)}`, false);
        }
      });
    }

    add("Done", "Send this list to whoever is fixing it.");
    setRunning(false);
  }, [add]);

  return (
    <main className="stage" style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Microphone diagnostics</h1>
      <p className="note" style={{ marginBottom: 16 }}>
        Runs each piece separately so we can see which one fails. Allow the microphone
        when asked, then talk for a few seconds.
      </p>

      <button className="control" onClick={run} disabled={running} style={{ minWidth: 200 }}>
        <span className="label">{running ? "Running…" : "Run diagnostics"}</span>
      </button>

      <ul style={{ listStyle: "none", padding: 0, marginTop: 20 }}>
        {lines.map((l, i) => (
          <li
            key={i}
            style={{
              padding: "7px 0",
              borderBottom: "1px solid rgba(111,216,255,0.12)",
              display: "flex",
              gap: 10,
              alignItems: "baseline",
            }}
          >
            <span style={{ width: 16, color: l.ok === false ? "#ff7a7a" : l.ok ? "#6fe8a0" : "#8fb3cc" }}>
              {l.ok === false ? "✕" : l.ok ? "✓" : "·"}
            </span>
            <span style={{ minWidth: 200, color: "#8fb3cc", fontSize: 13 }}>{l.label}</span>
            <span style={{ color: "#e2f0fc", fontSize: 13, wordBreak: "break-word" }}>{l.detail}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
