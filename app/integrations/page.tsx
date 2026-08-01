"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Toolkit = {
  slug: string;
  name: string;
  logo: string;
  description: string;
  connected: boolean;
  status: string | null;
  connectionId: string | null;
};

type Category = {
  id: string;
  label: string;
  blurb: string;
  glyph: string;
  toolkits: Toolkit[];
};

export default function IntegrationsPage() {
  const [data, setData] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    fetch("/api/integrations")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void load();
  }, []);

  const categories: Category[] = data?.categories ?? [];
  const other: Toolkit[] = data?.other ?? [];

  // Search spans every toolkit, curated or not.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const all = [...categories.flatMap((c) => c.toolkits), ...other];
    const seen = new Set<string>();
    return all
      .filter((t) => {
        if (seen.has(t.slug)) return false;
        seen.add(t.slug);
        return t.name.toLowerCase().includes(q) || t.slug.includes(q);
      })
      .slice(0, 60);
  }, [query, categories, other]);

  const connect = async (t: Toolkit) => {
    setBusy(t.slug);
    setError("");
    try {
      if (t.connected && t.connectionId) {
        const res = await fetch(`/api/integrations/connect?id=${encodeURIComponent(t.connectionId)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error((await res.json())?.error ?? "Could not disconnect");
        await load();
        return;
      }

      const res = await fetch("/api/integrations/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit: t.slug }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not start authorisation");
      window.location.href = body.redirectUrl;
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy("");
    }
  };

  const Card = (t: Toolkit) => (
    <button
      key={t.slug}
      className={`tk${t.connected ? " on" : ""}`}
      onClick={() => connect(t)}
      disabled={busy === t.slug}
      title={t.description || t.name}
    >
      {t.logo ? (
        // Remote logos from Composio's CDN; plain img avoids next/image domain config.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="logo" src={t.logo} alt="" loading="lazy" />
      ) : (
        <span className="logo" />
      )}
      <span className="meta">
        <span className="name">{t.name}</span>
        <span className="state">
          {busy === t.slug
            ? "working…"
            : t.connected
              ? "connected — click to remove"
              : "connect"}
        </span>
      </span>
    </button>
  );

  return (
    <div className="page">
      <Link href="/" className="sub">
        ← back
      </Link>
      <h1>Integrations</h1>
      <p className="sub">
        Everything CARVIS can reach, brokered by Composio — one provider, one place to authorise.
        {data?.total ? ` ${data.total} toolkits available.` : ""}
      </p>

      {error && <p className="line error">{error}</p>}
      {data && !data.enabled && (
        <p className="line error">{data.error}</p>
      )}

      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search all toolkits — Slack, Notion, Snowflake, Stripe…"
      />

      {!data && <p className="sub">Loading…</p>}

      {results ? (
        <>
          <div className="cat-head">
            <h2>{results.length} result{results.length === 1 ? "" : "s"}</h2>
          </div>
          <div className="grid">{results.map(Card)}</div>
        </>
      ) : (
        categories.map((c) => (
          <section key={c.id}>
            <div className="cat-head">
              <h2>
                {c.glyph} {c.label}
              </h2>
              <span className="blurb">{c.blurb}</span>
            </div>
            <div className="grid">{c.toolkits.map(Card)}</div>
          </section>
        ))
      )}
    </div>
  );
}
