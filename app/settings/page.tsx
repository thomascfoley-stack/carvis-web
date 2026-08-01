"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type LlmProvider = {
  id: string;
  label: string;
  format: string;
  baseUrl: string;
  models: string[];
  keyUrl: string;
  editableBaseUrl: boolean;
  note: string;
};

type TtsProvider = {
  id: string;
  label: string;
  needsKey: boolean;
  keyUrl: string;
  defaultVoice: string;
  voiceLabel: string;
  models: string[];
  defaultModel: string;
  editableBaseUrl: boolean;
  note: string;
};

export default function SettingsPage() {
  const [data, setData] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  // Local form state — API keys start blank and are only sent when typed.
  const [llm, setLlm] = useState({ providerId: "", model: "", baseUrl: "", apiKey: "" });
  const [tts, setTts] = useState({
    providerId: "",
    voiceId: "",
    model: "",
    baseUrl: "",
    apiKey: "",
  });
  const [prefs, setPrefs] = useState({
    userName: "sir",
    verbosity: "balanced",
    autoListen: true,
    bargeIn: true,
  });

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLlm({
          providerId: d.settings.llm.providerId,
          model: d.settings.llm.model,
          baseUrl: d.settings.llm.baseUrl,
          apiKey: "",
        });
        setTts({
          providerId: d.settings.tts.providerId,
          voiceId: d.settings.tts.voiceId,
          model: d.settings.tts.model,
          baseUrl: d.settings.tts.baseUrl,
          apiKey: "",
        });
        setPrefs(d.settings.prefs);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (!data) {
    return (
      <div className="page">
        <p className="sub">Loading…</p>
      </div>
    );
  }

  const llmProviders: LlmProvider[] = data.llmProviders;
  const ttsProviders: TtsProvider[] = data.ttsProviders;
  const llmP = llmProviders.find((p) => p.id === llm.providerId);
  const ttsP = ttsProviders.find((p) => p.id === tts.providerId);

  const save = async () => {
    setSaving(true);
    setSaved("");
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llm, tts, prefs }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const d = await res.json();
      setData({ ...data, settings: d.settings });
      setLlm((s) => ({ ...s, apiKey: "" }));
      setTts((s) => ({ ...s, apiKey: "" }));
      setSaved("Saved.");
      setTimeout(() => setSaved(""), 2500);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <Link href="/" className="sub">
        ← back
      </Link>
      <h1>Settings</h1>
      <p className="sub">
        Model and voice providers. Keys are stored server-side and never sent back to this page.
        {!data.settings.persistent && " No KV store is attached, so changes last only until the server restarts — set KV_REST_API_URL and KV_REST_API_TOKEN to persist them."}
      </p>

      {error && <p className="line error">{error}</p>}

      {/* ------------------------------ model ------------------------------ */}
      <div className="card">
        <h2>Language model</h2>

        <div className="row">
          <div className="field">
            <label>Provider</label>
            <select
              value={llm.providerId}
              onChange={(e) => {
                const p = llmProviders.find((x) => x.id === e.target.value);
                setLlm({
                  providerId: e.target.value,
                  model: p?.models[0] ?? "",
                  baseUrl: p?.baseUrl ?? "",
                  apiKey: "",
                });
              }}
            >
              {llmProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Model</label>
            {llmP?.models.length ? (
              <select value={llm.model} onChange={(e) => setLlm({ ...llm, model: e.target.value })}>
                {llmP.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!llmP.models.includes(llm.model) && llm.model && (
                  <option value={llm.model}>{llm.model}</option>
                )}
              </select>
            ) : (
              <input
                value={llm.model}
                onChange={(e) => setLlm({ ...llm, model: e.target.value })}
                placeholder="model id"
              />
            )}
          </div>
        </div>

        {llmP?.editableBaseUrl && (
          <div className="field">
            <label>Base URL</label>
            <input
              value={llm.baseUrl}
              onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })}
              placeholder="https://your-endpoint/v1"
            />
          </div>
        )}

        <div className="field">
          <label>
            API key {data.settings.llm.hasKey ? "(a key is already stored)" : "(none stored)"}
          </label>
          <input
            type="password"
            value={llm.apiKey}
            onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })}
            placeholder={data.settings.llm.hasKey ? "leave blank to keep current key" : "paste key"}
            autoComplete="off"
          />
          {llmP?.note && <span className="note">{llmP.note}</span>}
          {llmP?.keyUrl && (
            <span className="note">
              Get a key at <a href={llmP.keyUrl} target="_blank" rel="noreferrer">{llmP.keyUrl}</a>
            </span>
          )}
        </div>
      </div>

      {/* ------------------------------ voice ------------------------------ */}
      <div className="card">
        <h2>Voice</h2>

        <div className="row">
          <div className="field">
            <label>Provider</label>
            <select
              value={tts.providerId}
              onChange={(e) => {
                const p = ttsProviders.find((x) => x.id === e.target.value);
                setTts({
                  providerId: e.target.value,
                  voiceId: p?.defaultVoice ?? "",
                  model: p?.defaultModel ?? "",
                  baseUrl: "",
                  apiKey: "",
                });
              }}
            >
              {ttsProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{ttsP?.voiceLabel ?? "Voice"}</label>
            <input
              value={tts.voiceId}
              onChange={(e) => setTts({ ...tts, voiceId: e.target.value })}
              placeholder={ttsP?.defaultVoice}
            />
          </div>
        </div>

        {!!ttsP?.models.length && (
          <div className="field">
            <label>Voice model</label>
            <select value={tts.model} onChange={(e) => setTts({ ...tts, model: e.target.value })}>
              {ttsP.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        )}

        {ttsP?.editableBaseUrl && (
          <div className="field">
            <label>Base URL</label>
            <input
              value={tts.baseUrl}
              onChange={(e) => setTts({ ...tts, baseUrl: e.target.value })}
              placeholder="https://your-endpoint/v1"
            />
          </div>
        )}

        {ttsP?.needsKey && (
          <div className="field">
            <label>
              API key {data.settings.tts.hasKey ? "(a key is already stored)" : "(none stored)"}
            </label>
            <input
              type="password"
              value={tts.apiKey}
              onChange={(e) => setTts({ ...tts, apiKey: e.target.value })}
              placeholder={data.settings.tts.hasKey ? "leave blank to keep current key" : "paste key"}
              autoComplete="off"
            />
            {ttsP.keyUrl && (
              <span className="note">
                Get a key at <a href={ttsP.keyUrl} target="_blank" rel="noreferrer">{ttsP.keyUrl}</a>
              </span>
            )}
          </div>
        )}

        {ttsP?.note && <span className="note">{ttsP.note}</span>}
      </div>

      {/* --------------------------- behaviour ---------------------------- */}
      <div className="card">
        <h2>Behaviour</h2>

        <div className="row">
          <div className="field">
            <label>What JARVIS calls you</label>
            <input
              value={prefs.userName}
              onChange={(e) => setPrefs({ ...prefs, userName: e.target.value })}
            />
          </div>

          <div className="field">
            <label>How much it volunteers</label>
            <select
              value={prefs.verbosity}
              onChange={(e) => setPrefs({ ...prefs, verbosity: e.target.value })}
            >
              <option value="terse">Terse — one sentence, two items max</option>
              <option value="balanced">Balanced — a sentence or two, three items</option>
              <option value="detailed">Detailed — up to three sentences, five items</option>
            </select>
            <span className="note">
              Controls the consolidation budget. Ask &ldquo;tell me more&rdquo; or &ldquo;read it out&rdquo; to go
              deeper on any answer.
            </span>
          </div>
        </div>

        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={prefs.bargeIn}
              onChange={(e) => setPrefs({ ...prefs, bargeIn: e.target.checked })}
            />{" "}
            Let me interrupt while it&rsquo;s speaking
          </label>
          <span className="note">
            Speaking over JARVIS cuts it off, and its memory of the reply is trimmed to what you
            actually heard.
          </span>
        </div>
      </div>

      <button className="btn" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </button>
      {saved && <span className="saved">{saved}</span>}
    </div>
  );
}
