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

const TINY_MP3 = Buffer.from(
  // A syntactically valid, silent MPEG frame — enough for decode paths.
  "fffb90640000000000000000000000000000000000000000000000000000000000000000",
  "hex",
);

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
    res.end(TINY_MP3);
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
