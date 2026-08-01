"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type KeyState = { set: boolean; hint: string };
type Voice = { id: string; label: string; tag?: string };

export default function SetupPage() {
  const [data, setData] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  // The voice catalogue for the currently selected provider.
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceMeta, setVoiceMeta] = useState<any>(null);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceFilter, setVoiceFilter] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");

  // Secrets start blank on every load. A blank field means "keep what's
  // stored", so an existing key is never overwritten by accident.
  const [form, setForm] = useState({
    userName: "",
    mcpUrl: "",
    composioKey: "",
    llmProvider: "anthropic",
    llmModel: "",
    llmKey: "",
    ttsProvider: "openai",
    ttsVoice: "",
    ttsModel: "",
    ttsKey: "",
  });

  const load = () =>
    fetch("/api/credentials")
      .then((r) => (r.status === 401 ? (window.location.href = "/login") : r.json()))
      .then((d) => {
        if (!d) return;
        setData(d);
        setForm((f) => ({
          ...f,
          userName: d.prefs?.userName ?? "",
          mcpUrl: d.credentials.mcpUrl ?? "",
          llmProvider: d.credentials.llmProvider ?? "anthropic",
          llmModel: d.credentials.llmModel ?? "",
          ttsProvider: d.credentials.ttsProvider ?? "openai",
          ttsVoice: d.credentials.ttsVoice ?? "",
          ttsModel: d.credentials.ttsModel ?? "",
        }));
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void load();
  }, []);

  /**
   * Pull the voice list whenever the selected provider changes. The browser
   * engine is the one provider we can enumerate locally — its voices are
   * installed on this machine, not on a server.
   */
  const loadVoices = useCallback(async (provider: string, refresh = false) => {
    if (!provider) return;

    if (provider === "browser") {
      const speak = typeof window !== "undefined" ? window.speechSynthesis : null;
      const read = () =>
        setVoices(
          (speak?.getVoices() ?? []).map((v) => ({ id: v.name, label: v.name, tag: v.lang })),
        );
      read();
      // Chrome populates the list asynchronously and fires this once ready.
      if (speak) speak.onvoiceschanged = read;
      setVoiceMeta({ provider, local: true });
      return;
    }

    setLoadingVoices(true);
    try {
      const res = await fetch(`/api/voices?provider=${encodeURIComponent(provider)}`, {
        method: refresh ? "POST" : "GET",
      });
      const d = await res.json();
      setVoices(Array.isArray(d?.voices) ? d.voices : []);
      setVoiceMeta(d);
    } catch (e: any) {
      setVoices([]);
      setVoiceMeta({ error: String(e?.message ?? e) });
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  useEffect(() => {
    if (!data) return;
    setVoiceFilter("");
    void loadVoices(form.ttsProvider);
  }, [data, form.ttsProvider, loadVoices]);

  // Google alone returns hundreds of voices, so the list is only useful with a
  // filter. Matching id and tag as well as label lets you search by locale.
  const shownVoices = useMemo(() => {
    const q = voiceFilter.trim().toLowerCase();
    const list = q
      ? voices.filter((v) =>
          `${v.label} ${v.id} ${v.tag ?? ""}`.toLowerCase().includes(q),
        )
      : voices;
    return list.slice(0, 300);
  }, [voices, voiceFilter]);

  /** Audition the selected voice without saving first. */
  const preview = useCallback(async () => {
    setPreviewing(true);
    setPreviewError("");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "All systems are online. How can I help?",
          voice: form.ttsVoice,
          model: form.ttsModel,
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(
          d?.error === "browser-tts"
            ? "Save a key for this provider first."
            : (d?.error ?? `Preview failed (${res.status})`),
        );
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e: any) {
      setPreviewError(String(e?.message ?? e));
    } finally {
      setPreviewing(false);
    }
  }, [form.ttsVoice, form.ttsModel]);

  if (!data) {
    return (
      <div className="page">
        <p className="sub">Loading…</p>
      </div>
    );
  }

  const c = data.credentials;
  const llmP = data.llmProviders.find((p: any) => p.id === form.llmProvider);
  const ttsP = data.ttsProviders.find((p: any) => p.id === form.ttsProvider);

  // Changing provider drops the stored key on save — a key for one provider is
  // useless at another, and silently reusing it produces a 401 that looks like
  // the new key never took. Say so before they hit Save, not after.
  const llmProviderChanged = form.llmProvider !== c.llmProvider;
  const ttsProviderChanged = form.ttsProvider !== c.ttsProvider;

  const save = async () => {
    setSaving(true);
    setSaved("");
    setError("");
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, prefs: { userName: form.userName } }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? `Save failed (${res.status})`);
      setData({ ...data, credentials: d.credentials, prefs: d.prefs });
      setForm((f) => ({ ...f, composioKey: "", llmKey: "", ttsKey: "" }));
      setSaved("Saved.");
      setTimeout(() => setSaved(""), 2500);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/credentials", { method: "PUT" });
      setTestResult(await res.json());
    } catch (e: any) {
      setTestResult({ ok: false, error: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  };

  const keyLabel = (name: string, k: KeyState) =>
    `${name} ${k.set ? `(stored: ${k.hint})` : "(not set)"}`;

  return (
    <div className="page">
      <Link href="/" className="sub">
        ← back
      </Link>
      <h1>Setup</h1>
      <p className="sub">
        JARVIS runs on <strong>your</strong> keys — nothing is billed to anyone else, and there is
        no shared default. Keys are encrypted before storage and never sent back to this page.
        Signed in as {data.email}.
      </p>

      {error && <p className="line error">{error}</p>}
      {!data.storage.database && (
        <p className="line error">No database attached — credentials cannot be saved.</p>
      )}
      {!data.storage.encryption && (
        <p className="line error">
          No encryption key set (JARVIS_ENCRYPTION_KEY). Saving is disabled rather than storing
          keys in the clear.
        </p>
      )}
      {data.storage.stale && (
        <p className="line error">
          Your keys are still stored, but the server&rsquo;s encryption key has changed since they
          were saved, so they can no longer be read. Paste them in again below and they will
          stick. To stop this recurring, set <code>JARVIS_ENCRYPTION_KEY</code> to a fixed value
          you never rotate — otherwise rotating the Composio key wipes every stored credential.
        </p>
      )}

      <div className="card">
        <h2>What should JARVIS call you?</h2>
        <div className="field">
          <label>Leave blank and it will use no name at all — no &ldquo;sir&rdquo;.</label>
          <input
            value={form.userName}
            onChange={(e) => setForm({ ...form, userName: e.target.value })}
            placeholder="e.g. Thomas"
          />
          <span className="note">
            You can also just say &ldquo;call me Thomas&rdquo; out loud and it will stick.
          </span>
        </div>
      </div>

      <div className="card">
        <h2>Composio MCP</h2>
        <div className="field">
          <label>Your MCP endpoint URL</label>
          <input
            value={form.mcpUrl}
            onChange={(e) => setForm({ ...form, mcpUrl: e.target.value })}
            placeholder="https://mcp.composio.dev/…"
          />
          <span className="note">
            Every integration JARVIS can reach comes from this endpoint. Your tools, your
            connections, your account.
          </span>
        </div>
        <div className="field">
          <label>{keyLabel("Composio API key", c.composioKey)}</label>
          <input
            type="password"
            value={form.composioKey}
            onChange={(e) => setForm({ ...form, composioKey: e.target.value })}
            placeholder={c.composioKey.set ? "leave blank to keep the stored key" : "ak_…"}
            autoComplete="off"
          />
        </div>
        <button className="btn ghost" onClick={test} disabled={testing || !c.composioKey.set}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        {testResult && (
          <p className={`note ${testResult.ok ? "" : "err"}`} style={{ marginTop: 10 }}>
            {testResult.ok
              ? `Connected — ${testResult.toolCount} tools available${
                  testResult.sample?.length ? `: ${testResult.sample.join(", ")}…` : ""
                }`
              : `Failed: ${testResult.error}`}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Model</h2>
        <div className="row">
          <div className="field">
            <label>Provider</label>
            <select
              value={form.llmProvider}
              onChange={(e) => {
                const p = data.llmProviders.find((x: any) => x.id === e.target.value);
                setForm({
                  ...form,
                  llmProvider: e.target.value,
                  llmModel: p?.models?.[0] ?? "",
                  llmKey: "",
                });
              }}
            >
              {data.llmProviders.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            {llmP?.models?.length ? (
              <select
                value={form.llmModel}
                onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
              >
                {llmP.models.map((m: string) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.llmModel}
                onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
                placeholder="model id"
              />
            )}
          </div>
        </div>
        <div className="field">
          <label>{keyLabel("API key", c.llmKey)}</label>
          <input
            type="password"
            value={form.llmKey}
            onChange={(e) => setForm({ ...form, llmKey: e.target.value })}
            placeholder={
              llmProviderChanged
                ? "new provider — paste its key"
                : c.llmKey.set
                  ? "leave blank to keep the stored key"
                  : "paste key"
            }
            autoComplete="off"
          />
          {llmProviderChanged && c.llmKey.set && !form.llmKey.trim() && (
            <span className="note err">
              You changed provider. Saving without a key here clears the old one, because a{" "}
              {c.llmProvider} key will not work at {llmP?.label ?? form.llmProvider}.
            </span>
          )}
          {llmP?.keyUrl && (
            <span className="note">
              Get one at{" "}
              <a href={llmP.keyUrl} target="_blank" rel="noreferrer">
                {llmP.keyUrl}
              </a>
            </span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Voice</h2>
        <div className="row">
          <div className="field">
            <label>Provider</label>
            <select
              value={form.ttsProvider}
              onChange={(e) => {
                const p = data.ttsProviders.find((x: any) => x.id === e.target.value);
                setForm({
                  ...form,
                  ttsProvider: e.target.value,
                  ttsVoice: p?.defaultVoice ?? "",
                  ttsModel: p?.defaultModel ?? "",
                  ttsKey: "",
                });
              }}
            >
              {data.ttsProviders.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            {ttsP?.models?.length ? (
              <select
                value={form.ttsModel}
                onChange={(e) => setForm({ ...form, ttsModel: e.target.value })}
              >
                {ttsP.models.map((m: string) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.ttsModel}
                onChange={(e) => setForm({ ...form, ttsModel: e.target.value })}
                placeholder={ttsP?.defaultModel || "default"}
              />
            )}
          </div>
        </div>

        <div className="field">
          <label>
            {ttsP?.voiceLabel ?? "Voice"}
            {loadingVoices && <span className="note"> loading…</span>}
            {!loadingVoices && voices.length > 0 && (
              <span className="note"> {voices.length} available</span>
            )}
          </label>

          {voices.length > 0 ? (
            <>
              <input
                value={voiceFilter}
                onChange={(e) => setVoiceFilter(e.target.value)}
                placeholder="filter by name, accent or language…"
              />
              <select
                size={Math.min(10, Math.max(4, shownVoices.length))}
                value={form.ttsVoice}
                onChange={(e) => setForm({ ...form, ttsVoice: e.target.value })}
                style={{ marginTop: 8 }}
              >
                {/* A saved voice that isn't in the list must stay selectable,
                    or opening this page would silently change your voice. */}
                {form.ttsVoice && !voices.some((v) => v.id === form.ttsVoice) && (
                  <option value={form.ttsVoice}>{form.ttsVoice} (current)</option>
                )}
                {shownVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                    {v.tag ? ` — ${v.tag}` : ""}
                  </option>
                ))}
              </select>
              {shownVoices.length < voices.length && (
                <span className="note">
                  Showing {shownVoices.length} of {voices.length} — keep typing to narrow it.
                </span>
              )}
            </>
          ) : (
            <input
              value={form.ttsVoice}
              onChange={(e) => setForm({ ...form, ttsVoice: e.target.value })}
              placeholder={ttsP?.defaultVoice}
            />
          )}

          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn ghost"
              onClick={preview}
              disabled={previewing || !form.ttsVoice || !c.ttsKey.set}
              title="Speaks one line using the saved key for this provider."
            >
              {previewing ? "Playing…" : "▶ Preview"}
            </button>
            {ttsP?.listLive && (
              <button
                className="btn ghost"
                onClick={() => loadVoices(form.ttsProvider, true)}
                disabled={loadingVoices}
                title="Re-fetch from the provider — use after cloning a new voice."
              >
                {loadingVoices ? "Refreshing…" : "↻ Refresh list"}
              </button>
            )}
          </div>

          {previewError && <span className="note err">{previewError}</span>}
          {voiceMeta?.error && !voices.length && (
            <span className="note err">Could not list voices: {voiceMeta.error}</span>
          )}
          {voiceMeta?.stale && (
            <span className="note err">
              Showing a cached list — the provider could not be reached just now.
            </span>
          )}
          {!loadingVoices && !voices.length && !voiceMeta?.error && ttsP?.needsKey && (
            <span className="note">
              Save your {ttsP.label} key, then the voices from your account appear here.
            </span>
          )}

          {/* The list is a convenience, not a cage: a brand-new voice id may
              not be in it yet, and typing one has to keep working. */}
          {voices.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="note">Enter a voice ID directly</summary>
              <input
                value={form.ttsVoice}
                onChange={(e) => setForm({ ...form, ttsVoice: e.target.value })}
                placeholder={ttsP?.defaultVoice}
                style={{ marginTop: 6 }}
              />
            </details>
          )}
        </div>

        {ttsP?.needsKey && (
          <div className="field">
            <label>{keyLabel("API key", c.ttsKey)}</label>
            <input
              type="password"
              value={form.ttsKey}
              onChange={(e) => setForm({ ...form, ttsKey: e.target.value })}
              placeholder={
                ttsProviderChanged
                  ? "new provider — paste its key"
                  : c.ttsKey.set
                    ? "leave blank to keep the stored key"
                    : "paste key"
              }
              autoComplete="off"
            />
            {ttsProviderChanged && c.ttsKey.set && !form.ttsKey.trim() && (
              <span className="note err">
                You changed provider. Saving without a key here clears the old one, because a{" "}
                {c.ttsProvider} key will not work at {ttsP?.label ?? form.ttsProvider}.
              </span>
            )}
            {ttsP.keyUrl && (
              <span className="note">
                Get one at{" "}
                <a href={ttsP.keyUrl} target="_blank" rel="noreferrer">
                  {ttsP.keyUrl}
                </a>
              </span>
            )}
          </div>
        )}
        {ttsP?.note && <span className="note">{ttsP.note}</span>}
      </div>

      <button
        className="btn"
        onClick={save}
        disabled={saving || !data.storage.database || !data.storage.encryption}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saved && <span className="saved">{saved}</span>}
      {c.onboarded && (
        <Link href="/" className="saved" style={{ marginLeft: 16 }}>
          Start talking →
        </Link>
      )}
    </div>
  );
}
