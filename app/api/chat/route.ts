import { sessionFromRequest } from "@/lib/auth";
import { loadCredentials } from "@/lib/credentials";
import { recordFailure } from "@/lib/db";
import { loadMemories } from "@/lib/memory";
import { loadPrefs } from "@/lib/prefs";
import { systemPrompt } from "@/lib/prompt";
import { streamLLM, type CanonMsg, type ToolCall } from "@/lib/providers/llm";
import { redact } from "@/lib/redact";
import { buildCatalogue, runTool, toolLabel } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY = 16;

const encoder = new TextEncoder();
/** One JSON object per line, so the browser can act on each token as it lands. */
const frame = (obj: unknown) => encoder.encode(JSON.stringify(obj) + "\n");

export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const tz: string = typeof body?.tz === "string" && body.tz ? body.tz : "UTC";
  const now: string | undefined = typeof body?.now === "string" ? body.now : undefined;

  const history: CanonMsg[] = Array.isArray(body?.messages)
    ? body.messages
        .filter(
          (m: any) =>
            m &&
            ((m.role === "user" && typeof m.text === "string") ||
              (m.role === "assistant" && typeof m.text === "string")),
        )
        .slice(-MAX_HISTORY)
    : [];

  if (!history.length) return new Response("No messages", { status: 400 });

  // Bring-your-own-key: every call is billed to the caller's own account, so
  // there is no owner default to fall back to and no quota to enforce.
  const creds = await loadCredentials(session.email);
  if (!creds.llmKey) {
    return Response.json(
      { error: "No model key yet. Add yours in Setup.", needsOnboarding: true },
      { status: 428 },
    );
  }

  const [memories, prefs, catalogue] = await Promise.all([
    loadMemories(session.email),
    loadPrefs(session.email),
    buildCatalogue(creds, req.signal),
  ]);

  const system = systemPrompt({
    memories,
    prefs,
    now,
    timezone: tz,
    toolsAvailable: catalogue.tools.length > 3,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(frame(obj));
        } catch {
          closed = true;
        }
      };

      // Never silently drop capability: if the MCP endpoint is down or the
      // tool list was capped, the user should know why JARVIS seems limited.
      if (catalogue.note) send({ t: "note", v: catalogue.note });

      const messages: CanonMsg[] = [...history];

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          let text = "";
          let calls: ToolCall[] = [];
          let failed = false;

          for await (const ev of streamLLM({
            settings: {
              providerId: creds.llmProvider,
              model: creds.llmModel,
              apiKey: creds.llmKey,
            },
            system,
            messages,
            tools: catalogue.tools,
            signal: req.signal,
          })) {
            if (ev.type === "text") {
              text += ev.text;
              send({ t: "text", v: ev.text });
            } else if (ev.type === "tool_calls") {
              calls = ev.calls;
            } else if (ev.type === "error") {
              send({ t: "error", v: redact(ev.message) });
              failed = true;
              void recordFailure({
                node: `llm.${creds.llmProvider}`,
                errorClass: "ModelStreamError",
                message: ev.message,
                input: { model: creds.llmModel },
              });
            }
          }

          if (failed || !calls.length) break;

          for (const c of calls) send({ t: "status", v: toolLabel(c.name) });

          const results = await Promise.all(
            calls.map(async (c) => {
              const content = redact(
                await runTool(c.name, c.input ?? {}, {
                  tz,
                  email: session.email,
                  creds,
                  signal: req.signal,
                }),
              );
              if (/^(That failed|Tool error|That needs an MCP)/.test(content)) {
                void recordFailure({
                  node: `tool.${c.name}`,
                  errorClass: "ToolFailed",
                  message: content.slice(0, 500),
                  input: c.input ?? {},
                });
              }
              return { id: c.id, name: c.name, content };
            }),
          );

          messages.push({ role: "assistant", text, toolCalls: calls });
          messages.push({ role: "tool", results });
          send({ t: "status", v: "" });
        }

        send({ t: "done" });
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          send({ t: "error", v: redact(e?.message ?? e).slice(0, 300) });
          void recordFailure({
            node: "chat.stream",
            errorClass: e?.name ?? "Error",
            message: String(e?.message ?? e).slice(0, 500),
          });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
