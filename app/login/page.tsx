"use client";

import { useEffect, useState } from "react";

/**
 * Reads ?error= from location rather than useSearchParams — the hook forces a
 * Suspense boundary at build time and this page has nothing to suspend on.
 */
export default function LoginPage() {
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) setError(err);

    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => setNeedsCode(!!d.inviteRequired))
      .catch(() => undefined);
  }, []);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const q = code.trim() ? `?code=${encodeURIComponent(code.trim())}` : "";
    window.location.href = `/api/auth/start${q}`;
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={go}>
        <div className="mark">JARVIS</div>

        <p>
          A voice-first assistant. Sign in with your Google account to connect
          your mail and calendar. Your data stays scoped to your own account.
        </p>

        {error && <div className="err">{error}</div>}

        {needsCode && (
          <div className="field" style={{ textAlign: "left", marginBottom: 18 }}>
            <label>Invite code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="required while in beta"
              autoComplete="off"
              required
            />
          </div>
        )}

        <button className="google" type="submit" disabled={busy}>
          <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
            <path
              fill="#EA4335"
              d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.1 24.6c0-1.6-.1-2.8-.4-4H24v7.5h12.7c-.3 2.1-1.6 5.2-4.7 7.3l7.6 5.9c4.5-4.2 7.1-10.3 7.1-16.7z"
            />
            <path
              fill="#FBBC05"
              d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C.9 16.3 0 20 0 24s.9 7.7 2.6 10.8l7.8-6.1z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2 1.4-4.8 2.4-8.3 2.4-6.4 0-11.7-3.7-13.6-8.9l-7.8 6.1C6.5 42.6 14.6 48 24 48z"
            />
          </svg>
          {busy ? "Redirecting…" : "Sign in with Google"}
        </button>
      </form>
    </div>
  );
}
