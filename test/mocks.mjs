/**
 * Mock providers for the loop-test harness.
 *
 * Everything CARVIS talks to over the network has a stand-in here: an
 * OpenAI-format LLM, an Anthropic-format LLM, a TTS endpoint, and an MCP
 * server. They are deliberately configurable-per-request (via magic strings in
 * the input) so a single running instance can serve hundreds of different test
 * scenarios without restarts.
 */

import http from "node:http";

/**
 * Real, decodable audio.
 *
 * A bare MPEG frame header is syntactically valid but no browser will actually
 * decode it, so decodeAudioData rejects and the client reports "audio this
 * browser can't play" — which looks exactly like a production bug and cost real
 * time to tell apart. A minimal PCM WAV decodes everywhere, and browsers sniff
 * the bytes rather than trusting the content-type, so the route can keep
 * declaring audio/mpeg.
 */
const TINY_WAV = (() => {
  const sampleRate = 8000;
  const samples = 400; // 50ms
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // A quiet tone rather than digital silence: some decoders elide silence.
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 2000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
})();

const sse = (res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const lastUserText = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.find((c) => typeof c === "string" || c?.type === "text");
      if (typeof t === "string") return t;
      if (t?.text) return t.text;
      // tool_result-only user turn (anthropic shape)
      return "";
    }
  }
  return "";
};

/* ------------------------------- LLM mocks ------------------------------ */

/**
 * Magic inputs, shared by both formats:
 *   "TOOL:<name>:<json>"  -> emit one tool call, then on the next round answer
 *   "SLOWTEXT:<ms>"       -> wait before answering
 *   "ERRSTREAM"           -> emit a stream error event
 *   "HTTP:<status>"       -> non-200 response
 *   anything else         -> stream back "Echo: <input>" in 3 chunks
 */
export function startOpenAIMock(port) {
  const server = http.createServer(async (req, res) => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    if ((req.headers.authorization ?? "") !== "Bearer test-llm-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key sk-leaky-should-be-redacted" } }));
      return;
    }

    const body = await readBody(req);
    const text = lastUserText(body.messages);
    const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");

    const httpMatch = /^HTTP:(\d+)$/.exec(text);
    if (httpMatch) {
      res.writeHead(Number(httpMatch[1]), { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `forced ${httpMatch[1]}` } }));
      return;
    }

    const send = sse(res);
    const done = () => {
      res.write("data: [DONE]\n\n");
      res.end();
    };

    if (text === "ERRSTREAM") {
      // OpenAI streams errors as a plain event the client surfaces via catch;
      // emit a malformed-ish final chunk then close.
      send({ choices: [{ delta: { content: "partial " } }] });
      done();
      return;
    }

    const slow = /^SLOWTEXT:(\d+)$/.exec(text);
    if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));

    // Real OpenAI-format endpoints 400 on an empty tools array; the mock must
    // too, or the app can ship a request no provider would accept.
    if (Array.isArray(body.tools) && body.tools.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid 'tools': [] is too short" } }));
      return;
    }

    const tool = /^TOOL:([A-Za-z0-9_]+):(.*)$/s.exec(text);
    if (tool && !hasToolResult) {
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: tool[1], arguments: "" } },
              ],
            },
          },
        ],
      });
      send({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: tool[2] } }] } },
        ],
      });
      done();
      return;
    }

    const reply = hasToolResult
      ? `Tool said: ${(body.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content).join(" | ")}`
      : `Echo: ${text}`;

    for (const part of chunk3(reply)) {
      send({ choices: [{ delta: { content: part } }] });
      await new Promise((r) => setTimeout(r, 5));
    }
    done();
  });
  return listen(server, port);
}

export function startAnthropicMock(port) {
  const server = http.createServer(async (req, res) => {
    if (!req.url.endsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    if ((req.headers["x-api-key"] ?? "") !== "test-llm-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid x-api-key" } }));
      return;
    }

    const body = await readBody(req);
    const text = lastUserText(body.messages);
    const hasToolResult = (body.messages ?? []).some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"),
    );

    const send = sse(res);
    const finish = () => {
      send({ type: "message_stop" });
      res.end();
    };

    const tool = /^TOOL:([A-Za-z0-9_]+):(.*)$/s.exec(text);
    if (tool && !hasToolResult) {
      send({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: tool[1] },
      });
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: tool[2] },
      });
      send({ type: "content_block_stop", index: 0 });
      finish();
      return;
    }

    const reply = hasToolResult ? "Tool round complete." : `Echo: ${text}`;
    send({ type: "content_block_start", index: 0, content_block: { type: "text" } });
    for (const part of chunk3(reply)) {
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
    }
    send({ type: "content_block_stop", index: 0 });
    finish();
  });
  return listen(server, port);
}

/* -------------------------------- TTS mock ------------------------------ */

/**
 * OpenAI-compatible /audio/speech.
 *   voice "slow"   -> 1200ms delay
 *   voice "boom"   -> 500 with a fake secret in the body (redaction test)
 *   voice "html"   -> 200 text/html (decode-failure path)
 */
export function startTtsMock(port) {
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith("/voices")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          voices: [
            { id: "mock-a", display_name: "Mock A", locale: "en-US" },
            { id: "mock-b", display_name: "Mock B", locale: "en-GB" },
          ],
        }),
      );
      return;
    }
    if (!req.url.endsWith("/audio/speech")) {
      res.writeHead(404).end();
      return;
    }
    if ((req.headers.authorization ?? "") !== "Bearer test-tts-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "denied" }));
      return;
    }

    const body = await readBody(req);
    if (body.voice === "slow") await new Promise((r) => setTimeout(r, 1200));
    if (body.voice === "boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "upstream exploded, key sk-boom1234567890abcd leaked" }));
      return;
    }
    if (body.voice === "html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>error page pretending to be audio</html>");
      return;
    }

    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(TINY_WAV);
  });
  return listen(server, port);
}

/* -------------------------------- MCP mock ------------------------------ */

/**
 * JSON-RPC over Streamable HTTP, faithful where it matters:
 *   - requires initialize before anything else (-32002 otherwise)
 *   - hands out a session id; honours mcp-session-id
 *   - `expireSessions()` kills every live session -> next call 404s, which is
 *     exactly the failure the client's re-handshake has to absorb
 *   - tools: echo_tool, slow_tool (arg ms), fail_tool, big_tool (arg kb)
 *   - answers in SSE framing when the test asks for it (?sse=1)
 */
export function startMcpMock(port) {
  const sessions = new Set();
  let seq = 0;
  const stats = { initializes: 0, calls: 0, listeds: 0, rejected404: 0 };

  const server = http.createServer(async (req, res) => {
    // Real Composio rejects a request carrying both auth headers ("Multiple
    // authentication modes were provided"). Enforce it here so the client can
    // never regress to belt-and-braces auth again.
    if (req.headers.authorization && req.headers["x-api-key"]) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Multiple authentication modes were provided. Provide exactly one authentication mode per request." },
        }),
      );
      return;
    }

    // ?wantauth=bearer simulates a server that only accepts the Bearer form,
    // exercising the client's 401 auth-mode flip — and, because every later
    // request must keep succeeding, that the flipped mode survives the
    // session-id update instead of reverting to the first guess.
    const wantAuth = new URL(req.url, "http://x").searchParams.get("wantauth");
    if (wantAuth === "bearer" && !req.headers.authorization) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bearer token required" } }));
      return;
    }

    // OAuth-mode endpoint, Composio-style: no API keys, only Bearer JWTs, and
    // an unauthenticated request is told where the authorization server lives.
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        resource: `http://127.0.0.1:${port}/?oauth=1`,
        authorization_servers: ["http://127.0.0.1:4314"],
        bearer_methods_supported: ["header"],
      }));
      return;
    }
    const oauthMode = new URL(req.url, "http://x").searchParams.get("oauth") === "1";
    if (oauthMode && !(req.headers.authorization ?? "").startsWith("Bearer eyJ")) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="unauthorized", resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: "Authorization required" }));
      return;
    }

    const body = await readBody(req);
    const sid = req.headers["mcp-session-id"];
    const asSse = new URL(req.url, "http://x").searchParams.get("sse") === "1";

    const reply = (payload, extraHeaders = {}) => {
      if (asSse) {
        res.writeHead(200, { "content-type": "text/event-stream", ...extraHeaders });
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...extraHeaders });
        res.end(JSON.stringify(payload));
      }
    };

    // Notifications: no id — must be ACKed with 202 and an empty body.
    if (body.method?.startsWith("notifications/")) {
      if (body.id !== undefined) {
        reply({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "notification carried an id" } });
        return;
      }
      res.writeHead(202).end();
      return;
    }

    if (body.method === "initialize") {
      stats.initializes++;
      const id = `sess_${++seq}`;
      sessions.add(id);
      reply(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-mcp", version: "1.0.0" },
          },
        },
        { "mcp-session-id": id },
      );
      return;
    }

    // Everything else needs a live session.
    if (!sid || !sessions.has(sid)) {
      stats.rejected404++;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return;
    }

    if (body.method === "tools/list") {
      stats.listeds++;
      const tools = [
        { name: "echo_tool", description: "Echoes its input", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "slow_tool", description: "Sleeps then answers", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
        { name: "fail_tool", description: "Always errors", inputSchema: { type: "object", properties: {} } },
        { name: "big_tool", description: "Returns kb kilobytes", inputSchema: { type: "object", properties: { kb: { type: "number" } } } },
        // Enough filler to cross the MAX_REMOTE_TOOLS=48 cap.
        ...Array.from({ length: 60 }, (_, i) => ({
          name: `filler_tool_${i}`,
          description: `Filler ${i}`,
          inputSchema: { type: "object", properties: {} },
        })),
      ];
      reply({ jsonrpc: "2.0", id: body.id, result: { tools } });
      return;
    }

    if (body.method === "tools/call") {
      stats.calls++;
      const { name, arguments: args = {} } = body.params ?? {};
      if (name === "fail_tool") {
        reply({
          jsonrpc: "2.0",
          id: body.id,
          result: { isError: true, content: [{ type: "text", text: "deliberate failure ak_secretsecret123" }] },
        });
        return;
      }
      if (name === "slow_tool") {
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 100)));
        reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `slept ${args.ms}` }] } });
        return;
      }
      if (name === "big_tool") {
        const kb = Math.min(Number(args.kb ?? 1), 64);
        reply({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "x".repeat(kb * 1024) }] },
        });
        return;
      }
      reply({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] },
      });
      return;
    }

    reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `no such method ${body.method}` } });
  });

  return listen(server, port).then((handle) => ({
    ...handle,
    stats,
    expireSessions: () => sessions.clear(),
  }));
}

/* ------------------------------- OAuth mock ----------------------------- */

/**
 * The smallest authorization server that satisfies the MCP OAuth dance:
 * metadata discovery, open dynamic registration, an authorize endpoint that
 * consents instantly (bouncing straight back with a code), and a token
 * endpoint issuing JWT-shaped bearers. Faithful where it matters: the token
 * grant requires the PKCE verifier and the registered client id.
 */
export function startOAuthMock(port) {
  const codes = new Map(); // code -> { redirectUri }
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: `http://127.0.0.1:${port}`,
        authorization_endpoint: `http://127.0.0.1:${port}/oauth2/authorize`,
        token_endpoint: `http://127.0.0.1:${port}/oauth2/token`,
        registration_endpoint: `http://127.0.0.1:${port}/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }

    if (url.pathname === "/oauth2/register") {
      const body = await readBody(req);
      if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length) {
        json(400, { error: "invalid_redirect_uri" });
        return;
      }
      json(201, { client_id: "client_mock_1", token_endpoint_auth_method: "none" });
      return;
    }

    if (url.pathname === "/oauth2/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (url.searchParams.get("client_id") !== "client_mock_1" || !url.searchParams.get("code_challenge")) {
        json(400, { error: "invalid_request" });
        return;
      }
      const code = `code_${++seq}`;
      codes.set(code, { redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }

    if (url.pathname === "/oauth2/token") {
      const raw = await new Promise((r) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => r(d));
      });
      const p = new URLSearchParams(raw);
      if (p.get("client_id") !== "client_mock_1") {
        json(401, { error: "invalid_client" });
        return;
      }
      if (p.get("grant_type") === "authorization_code") {
        const known = codes.get(p.get("code"));
        if (!known || !p.get("code_verifier")) {
          json(400, { error: "invalid_grant" });
          return;
        }
        codes.delete(p.get("code"));
        json(200, {
          access_token: `eyJtb2NrIn0.access${++seq}.sig`,
          refresh_token: `refresh_${seq}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      if (p.get("grant_type") === "refresh_token" && (p.get("refresh_token") ?? "").startsWith("refresh_")) {
        json(200, {
          access_token: `eyJtb2NrIn0.refreshed${++seq}.sig`,
          refresh_token: `refresh_${seq}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      json(400, { error: "unsupported_grant_type" });
      return;
    }

    json(404, { error: "not_found" });
  });
  return listen(server, port);
}

/* ------------------------------- utilities ------------------------------ */

function chunk3(text) {
  const third = Math.max(1, Math.ceil(text.length / 3));
  const out = [];
  for (let i = 0; i < text.length; i += third) out.push(text.slice(i, i + third));
  return out;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}
