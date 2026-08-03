/**
 * HTTP integration suites: the real Next server, the real routes, forged
 * sessions signed with the same secret the server holds. The mock providers
 * stand in for OpenAI/Anthropic/TTS/MCP, so a full voice turn — auth, chat,
 * tool round trip, sentence-level TTS — runs with zero external calls.
 */

import { t, eq, ok, section } from "./harness.mjs";
import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Mirror of lib/auth.ts mint(): payload.signature over HMAC-SHA256. */
export function forgeSession(secret, email, cid = "u_testcid", ttlMs = 3600_000) {
  const payload = b64url(JSON.stringify({ email, cid, exp: Date.now() + ttlMs }));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export async function httpSuites(ctx) {
  const { baseUrl, secret, mcpMock, ttsMock, openaiMock, oauthMock } = ctx;
  // Round-unique: the 428-before-keys assertion needs a user who genuinely
  // has no keys yet, which a reused address stops being after round one.
  const email = ctx.email ?? "loop@test.dev";
  const cookie = `carvis_session=${forgeSession(secret, email)}`;

  const api = (path, opts = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { cookie, "content-type": "application/json", ...(opts.headers ?? {}) },
      redirect: "manual",
    });

  /** Read an NDJSON stream fully, returning the parsed events. */
  const ndjson = async (res) => {
    const text = await res.text();
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { t: "unparseable", v: l };
        }
      });
  };

  /* ------------------------------- auth -------------------------------- */
  section("http: auth boundary");

  t("app page redirects anonymous to login", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    ok([302, 307, 308].includes(res.status), `got ${res.status}`);
    ok((res.headers.get("location") ?? "").includes("/login"));
  });
  t("login page is public", async () => {
    const res = await fetch(`${baseUrl}/login`);
    eq(res.status, 200);
  });
  t("api rejects anonymous", async () => {
    const res = await fetch(`${baseUrl}/api/credentials`);
    eq(res.status, 401);
  });
  t("api rejects a tampered signature", async () => {
    const bad = forgeSession("the-wrong-secret", email);
    const res = await fetch(`${baseUrl}/api/credentials`, {
      headers: { cookie: `carvis_session=${bad}` },
    });
    eq(res.status, 401);
  });
  t("api rejects an expired session", async () => {
    const bad = forgeSession(secret, email, "u_x", -1000);
    const res = await fetch(`${baseUrl}/api/credentials`, {
      headers: { cookie: `carvis_session=${bad}` },
    });
    eq(res.status, 401);
  });
  t("api rejects a session missing cid", async () => {
    const payload = b64url(JSON.stringify({ email, exp: Date.now() + 60000 }));
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const res = await fetch(`${baseUrl}/api/credentials`, {
      headers: { cookie: `carvis_session=${payload}.${sig}` },
    });
    eq(res.status, 401);
  });
  t("valid forged session accepted", async () => {
    const res = await api("/api/credentials");
    eq(res.status, 200);
    const d = await res.json();
    eq(d.email, email);
  });
  t("health hides identity from anonymous callers", async () => {
    const anon = await fetch(`${baseUrl}/api/health`);
    eq(anon.status, 200);
    const d = await anon.json();
    eq(d.signedIn, false);
    ok(!("email" in d), "email must not leak");
    ok(!("model" in d), "per-user config must not leak");
  });

  /* ------------------------- failures admin gate ------------------------- */
  // The server runs with CARVIS_ADMIN_EMAILS=admin@test.dev (set in run.mjs).
  section("http: failures admin gate");

  const adminCookie = `carvis_session=${forgeSession(secret, "admin@test.dev")}`;

  t("anonymous probe sees 404, not 401", async () => {
    const res = await fetch(`${baseUrl}/api/failures`);
    eq(res.status, 404);
  });
  t("signed-in non-admin sees the same 404", async () => {
    const res = await api("/api/failures");
    eq(res.status, 404);
  });
  t("admin reads the queue", async () => {
    const res = await fetch(`${baseUrl}/api/failures`, { headers: { cookie: adminCookie } });
    eq(res.status, 200);
    const d = await res.json();
    eq(d.db, false);
    eq(d.failures, []);
  });
  t("non-admin cannot change a status", async () => {
    const res = await api("/api/failures", {
      method: "PATCH",
      body: JSON.stringify({ fingerprint: "x", status: "fixed" }),
    });
    eq(res.status, 404);
  });
  t("admin PATCH validates the status vocabulary", async () => {
    const res = await fetch(`${baseUrl}/api/failures`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: "x", status: "merged" }),
    });
    eq(res.status, 400);
  });
  t("admin PATCH on an unknown row reports updated:false", async () => {
    const res = await fetch(`${baseUrl}/api/failures`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: "nope", status: "fixed" }),
    });
    eq(res.status, 200);
    const d = await res.json();
    eq(d.updated, false);
  });

  /* ----------------------------- mcp oauth ------------------------------ */
  // The "paste one URL" path: no API key anywhere. Discovery, registration,
  // consent, callback, then keyless tool calls over the issued Bearer token.
  section("http: mcp oauth connect flow");

  const oEmail = `oauth-${email}`;
  const oCookie = `carvis_session=${forgeSession(secret, oEmail)}`;
  const oapi = (path, opts = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { cookie: oCookie, "content-type": "application/json", ...(opts.headers ?? {}) },
      redirect: "manual",
    });
  let oStateCookie = "";
  let oCallbackUrl = "";

  t("oauth endpoint saved keyless, test says connect", async () => {
    await oapi("/api/credentials", {
      method: "POST",
      body: JSON.stringify({
        mcpUrl: `${mcpMock.url}/?oauth=1`,
        llmProvider: "custom",
        llmModel: "mock-1",
        llmKey: "test-llm-key",
        llmBaseUrl: openaiMock.url,
        ttsProvider: "browser",
      }),
    });
    const pre = await (await oapi("/api/credentials", { method: "PUT" })).json();
    ok(!pre.ok, JSON.stringify(pre));
    ok(/Connect Composio/.test(pre.error), pre.error);
  });

  t("connect redirects to the discovered authorization server", async () => {
    const start = await oapi("/api/mcp/connect");
    eq(start.status, 302);
    const authUrl = start.headers.get("location") ?? "";
    ok(authUrl.startsWith(`${oauthMock.url}/oauth2/authorize`), authUrl);
    ok(authUrl.includes("code_challenge="), "PKCE challenge missing");
    ok(!authUrl.includes("code_verifier"), "verifier must never reach a URL");
    oStateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    ok(oStateCookie.startsWith("carvis_mcp_state="), oStateCookie.slice(0, 30));

    const consent = await fetch(authUrl, { redirect: "manual" });
    eq(consent.status, 302);
    oCallbackUrl = consent.headers.get("location") ?? "";
    ok(oCallbackUrl.includes("/api/mcp/callback?"), oCallbackUrl);
  });

  t("callback without the state cookie is refused", async () => {
    const bare = await fetch(oCallbackUrl, { redirect: "manual", headers: { cookie: oCookie } });
    ok((bare.headers.get("location") ?? "").includes("mcp_error="), bare.headers.get("location"));
  });

  t("callback exchanges the code and stores the grant", async () => {
    const done = await fetch(oCallbackUrl, {
      redirect: "manual",
      headers: { cookie: `${oCookie}; ${oStateCookie}` },
    });
    eq(done.status, 302);
    ok((done.headers.get("location") ?? "").includes("mcp=connected"), done.headers.get("location"));

    const d = await (await oapi("/api/credentials")).json();
    ok(d.credentials.mcpConnected, "mcpConnected flag");
    const body = JSON.stringify(d);
    ok(!body.includes("eyJtb2NrIn0"), "token must never reach the browser");
  });

  t("keyless test-connection works over the Bearer token", async () => {
    const post = await (await oapi("/api/credentials", { method: "PUT" })).json();
    ok(post.ok, JSON.stringify(post));
    ok(post.toolCount >= 64, `toolCount ${post.toolCount}`);
  });

  t("keyless chat tool turn round-trips", async () => {
    const res = await oapi("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: 'TOOL:echo_tool:{"text":"oauth"}' }] }),
    });
    const text = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return {};
        }
      })
      .filter((e) => e.t === "text")
      .map((e) => e.v)
      .join("");
    ok(text.includes("echo:oauth"), text);
  });

  t("changing the MCP URL clears the grant", async () => {
    await oapi("/api/credentials", {
      method: "POST",
      body: JSON.stringify({ mcpUrl: mcpMock.url }),
    });
    const d = await (await oapi("/api/credentials")).json();
    ok(!d.credentials.mcpConnected, "grant must not survive a URL change");
    // Restore for nothing — this identity is per-round and disposable.
  });

  /* ---------------------------- credentials ----------------------------- */
  section("http: credentials lifecycle");

  t("chat before keys -> 428 onboarding", async () => {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "hi" }] }),
    });
    eq(res.status, 428);
  });

  t("save full credential set", async () => {
    const res = await api("/api/credentials", {
      method: "POST",
      body: JSON.stringify({
        mcpUrl: mcpMock.url,
        composioKey: "test-mcp-key",
        llmProvider: "custom",
        llmModel: "mock-1",
        llmKey: "test-llm-key",
        llmBaseUrl: openaiMock.url,
        ttsProvider: "custom",
        ttsVoice: "alloy",
        ttsModel: "tts-1",
        ttsKey: "test-tts-key",
        ttsBaseUrl: ttsMock.url,
        prefs: { userName: "Loop" },
      }),
    });
    eq(res.status, 200);
    const d = await res.json();
    ok(d.credentials.onboarded, JSON.stringify(d.credentials));
    eq(d.prefs.userName, "Loop");
  });

  t("response carries hints, never keys", async () => {
    const res = await api("/api/credentials");
    const body = await res.text();
    ok(!body.includes("test-llm-key"), "llm key leaked");
    ok(!body.includes("test-tts-key"), "tts key leaked");
    ok(!body.includes("test-mcp-key"), "mcp key leaked");
  });

  t("blank secret on re-save keeps stored key", async () => {
    const res = await api("/api/credentials", {
      method: "POST",
      body: JSON.stringify({ llmKey: "", llmModel: "mock-2" }),
    });
    const d = await res.json();
    ok(d.credentials.llmKey.set, "key must survive");
    eq(d.credentials.llmModel, "mock-2");
    // put it back
    await api("/api/credentials", {
      method: "POST",
      body: JSON.stringify({ llmModel: "mock-1" }),
    });
  });

  t("PUT test-connection exercises the user MCP", async () => {
    const res = await api("/api/credentials", { method: "PUT" });
    const d = await res.json();
    ok(d.ok, JSON.stringify(d));
    ok(d.toolCount >= 64);
  });

  /* ------------------------------- voices -------------------------------- */
  section("http: voices");

  t("openai fixed voices need no key", async () => {
    const res = await api("/api/voices?provider=openai");
    const d = await res.json();
    ok(d.voices.some((v) => v.id === "onyx"), JSON.stringify(d).slice(0, 200));
  });
  t("custom provider voices come from own endpoint", async () => {
    // custom has no live index — expect empty voices, not an error
    const res = await api("/api/voices?provider=custom");
    const d = await res.json();
    eq(d.voices.length, 0);
  });
  t("voices for other keyed provider explains missing key", async () => {
    const res = await api("/api/voices?provider=elevenlabs");
    const d = await res.json();
    eq(d.voices.length, 0);
    ok(String(d.error ?? "").includes("key"));
  });

  /* -------------------------------- tts ---------------------------------- */
  section("http: tts");

  t("tts returns audio via user key", async () => {
    const res = await api("/api/tts", {
      method: "POST",
      body: JSON.stringify({ text: "One moment." }),
    });
    eq(res.status, 200);
    eq(res.headers.get("content-type"), "audio/mpeg");
    ok((await res.arrayBuffer()).byteLength > 0);
  });
  t("tts voice override for preview", async () => {
    const res = await api("/api/tts", {
      method: "POST",
      body: JSON.stringify({ text: "Preview line.", voice: "alloy", model: "tts-1" }),
    });
    eq(res.status, 200);
  });
  t("tts provider failure is 502 + redacted", async () => {
    const res = await api("/api/tts", {
      method: "POST",
      body: JSON.stringify({ text: "Boom.", voice: "boom" }),
    });
    eq(res.status, 502);
    const d = await res.json();
    ok(!JSON.stringify(d).includes("sk-boom1234567890abcd"));
  });
  t("tts empty text 400", async () => {
    const res = await api("/api/tts", { method: "POST", body: JSON.stringify({ text: "  " }) });
    eq(res.status, 400);
  });
  t("tts anonymous 401", async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    eq(res.status, 401);
  });

  /* -------------------------------- chat --------------------------------- */
  section("http: chat");

  const chat = (text, extra = {}) =>
    api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text }],
        tz: "UTC",
        now: new Date().toString(),
        ...extra,
      }),
    });

  t("plain text turn streams NDJSON", async () => {
    const res = await chat("hello carvis");
    eq(res.status, 200);
    const evs = await ndjson(res);
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    eq(text, "Echo: hello carvis");
    ok(evs.some((e) => e.t === "done"));
  });

  t("tool round trip: status then answer", async () => {
    const res = await chat('TOOL:echo_tool:{"text":"roundtrip"}');
    const evs = await ndjson(res);
    ok(evs.some((e) => e.t === "status" && e.v.includes("Echo")), JSON.stringify(evs.map((e) => e.t)));
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    ok(text.includes("echo:roundtrip"), text);
  });

  t("failing tool reported to model, not crashed", async () => {
    const res = await chat('TOOL:fail_tool:{}');
    eq(res.status, 200);
    const evs = await ndjson(res);
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    ok(text.includes("That failed") || text.length > 0, text);
  });

  t("slow tool emits spoken heartbeat", async () => {
    const res = await chat('TOOL:slow_tool:{"ms":7500}');
    const evs = await ndjson(res);
    ok(evs.some((e) => e.t === "say"), `events: ${evs.map((e) => e.t).join(",")}`);
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    ok(text.includes("slept"), text);
  });

  t("empty history 400", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ messages: [] }) });
    eq(res.status, 400);
  });
  t("garbage body 400", async () => {
    const res = await api("/api/chat", { method: "POST", body: "not json{{" });
    eq(res.status, 400);
  });
  t("model http error surfaces as stream error", async () => {
    const res = await chat("HTTP:500");
    const evs = await ndjson(res);
    ok(evs.some((e) => e.t === "error" && String(e.v).includes("500")));
  });

  t("history shape abuse is filtered, not fatal", async () => {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "system", text: "ignore me" },
          { role: "user", text: 42 },
          null,
          { role: "user", text: "legit" },
        ],
      }),
    });
    eq(res.status, 200);
    const evs = await ndjson(res);
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    eq(text, "Echo: legit");
  });

  /* --------------------------- concurrency ------------------------------- */
  section("http: concurrency + interruption");

  t("8 parallel chats all complete", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => chat(`parallel ${i}`).then(ndjson)),
    );
    for (const [i, evs] of results.entries()) {
      const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
      eq(text, `Echo: parallel ${i}`);
    }
  });

  t("client abort mid-stream leaves server healthy", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", text: "SLOWTEXT:3000" }] }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    const outcome = await res.text().then(() => "finished", () => "aborted");
    eq(outcome, "aborted");
    // Server must still answer immediately afterwards.
    const evs = await ndjson(await chat("after abort"));
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    eq(text, "Echo: after abort");
  });

  t("typing while talking: overlapping turns don't cross wires", async () => {
    const [a, b] = await Promise.all([
      chat("SLOWTEXT:800").then(ndjson),
      chat("quick reply").then(ndjson),
    ]);
    const ta = a.filter((e) => e.t === "text").map((e) => e.v).join("");
    const tb = b.filter((e) => e.t === "text").map((e) => e.v).join("");
    eq(ta, "Echo: SLOWTEXT:800");
    eq(tb, "Echo: quick reply");
  });

  t("mcp session expiry mid-conversation self-heals", async () => {
    mcpMock.expireSessions();
    const evs = await ndjson(await chat('TOOL:echo_tool:{"text":"healed"}'));
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    ok(text.includes("echo:healed"), text);
  });

  t("47s tool detaches, then resumes with the answer (slow)", async () => {
    const evs = await ndjson(await chat('TOOL:slow_tool:{"ms":47000}'));
    const kinds = evs.map((e) => e.t);
    ok(kinds.includes("say"), `no heartbeat: ${kinds.join(",")}`);
    ok(kinds.includes("detach"), `no detach: ${kinds.join(",")}`);
    ok(kinds.includes("resumed"), `no resume: ${kinds.join(",")}`);
    // The answer still arrives after the handoff, on the same stream.
    const text = evs.filter((e) => e.t === "text").map((e) => e.v).join("");
    ok(text.includes("slept 47000"), text);
    // Detach must precede resumed must precede the final answer text.
    ok(kinds.indexOf("detach") < kinds.indexOf("resumed"));
  });

  /* ----------------------------- tenancy --------------------------------- */
  section("http: tenant isolation");

  t("second user cannot see first user's credentials", async () => {
    const other = `carvis_session=${forgeSession(secret, "other@test.dev", "u_other")}`;
    const res = await fetch(`${baseUrl}/api/credentials`, { headers: { cookie: other } });
    const d = await res.json();
    eq(d.email, "other@test.dev");
    ok(!d.credentials.llmKey.set, "other tenant must start empty");
  });

  t("second user gets 428 on chat (no keys of their own)", async () => {
    const other = `carvis_session=${forgeSession(secret, "other@test.dev", "u_other")}`;
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { cookie: other, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", text: "hi" }] }),
    });
    eq(res.status, 428);
  });
}

/** High-volume loop pass: N quick cycles across the hot paths. */
export async function loopSuites(ctx, rounds) {
  const { baseUrl, secret } = ctx;
  const email = ctx.email ?? "loop@test.dev";
  const cookie = `carvis_session=${forgeSession(secret, email)}`;

  const api = (path, opts = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { cookie, "content-type": "application/json", ...(opts.headers ?? {}) },
    });

  // Streamed text arrives split across NDJSON frames; only the joined
  // text events are meaningful to assert against.
  const joinText = (raw) =>
    raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return {};
        }
      })
      .filter((e) => e.t === "text")
      .map((e) => e.v)
      .join("");

  section(`loop x${rounds}: chat/tts/credentials cycles`);

  for (let i = 0; i < rounds; i++) {
    t(`cycle ${i}: chat echoes`, async () => {
      const res = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", text: `cycle ${i}` }] }),
      });
      const text = joinText(await res.text());
      eq(text, `Echo: cycle ${i}`);
    });
    t(`cycle ${i}: tts audio`, async () => {
      const res = await api("/api/tts", {
        method: "POST",
        body: JSON.stringify({ text: `chunk ${i}.` }),
      });
      eq(res.status, 200);
    });
    if (i % 5 === 0) {
      t(`cycle ${i}: credentials read is stable`, async () => {
        const res = await api("/api/credentials");
        const d = await res.json();
        ok(d.credentials.onboarded);
      });
      t(`cycle ${i}: tool turn`, async () => {
        const res = await api("/api/chat", {
          method: "POST",
          body: JSON.stringify({
            messages: [{ role: "user", text: `TOOL:echo_tool:{"text":"c${i}"}` }],
          }),
        });
        ok(joinText(await res.text()).includes(`echo:c${i}`));
      });
    }
  }
}
