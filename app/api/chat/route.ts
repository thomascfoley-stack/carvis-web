import { sessionFromRequest } from "@/lib/auth";
import { composioEnabled } from "@/lib/composio";
import { consumeMessage, dbEnabled, findUser, recordFailure } from "@/lib/db";
import { loadMemories } from "@/lib/memory";
import { systemPrompt } from "@/lib/prompt";
import { streamLLM, type CanonMsg, type ToolCall } from "@/lib/providers/llm";
import { getSettings } from "@/lib/store";
import { runTool, toolCatalogue, toolLabel } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY = 16;
const DEFAULT_DAILY_LIMIT = 50;

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

  // The client sends canonical messages; assistant turns may have been
  // truncated to what was actually heard before an interruption.
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

  // Quota. The owner's keys pay for everyone, so this is the only thing
  // between one enthusiastic user and a surprising invoice.
  if (dbEnabled()) {
    try {
      const user = await findUser(session.email);
      if (user?.status && user.status !== "active") {
        return Response.json({ error: "This account is suspended." }, { status: 403 });
      }
      const limit = user?.daily_limit ?? DEFAULT_DAILY_LIMIT;
      const quota = await consumeMessage(session.email, limit);
      if (!quota.allowed) {
        return Response.json(
          { error: `Daily limit reached (${quota.limit} messages). Resets at midnight UTC.` },
          { status: 429 },
        );
      }
    } catch (e) {
      // A quota backend outage shouldn't take the app down, but it is worth
      // recording — an un-metered window is exactly when bills happen.
      void recordFailure({
        node: "chat.quota",
        errorClass: "QuotaCheckFailed",
        message: String(e).slice(0, 500),
      });
    }
  }

  const settings = await getSettings();
  if (!settings.llm.apiKey) {
    return Response.json(
      { error: "No model API key configured. Add one in Settings." },
      { status: 503 },
    );
  }

  const memories = await loadMemories(session.email);
  const tools = toolCatalogue();
  const system = systemPrompt({
    memories,
    prefs: settings.prefs,
    now,
    timezone: tz,
    toolsAvailable: composioEnabled(),
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

      const messages: CanonMsg[] = [...history];

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          let text = "";
          let calls: ToolCall[] = [];
          let failed = false;

          for await (const ev of streamLLM({
            settings: settings.llm,
            system,
            messages,
            tools,
            signal: req.signal,
          })) {
            if (ev.type === "text") {
              text += ev.text;
              send({ t: "text", v: ev.text });
            } else if (ev.type === "tool_calls") {
              calls = ev.calls;
            } else if (ev.type === "error") {
              send({ t: "error", v: ev.message });
              failed = true;
              void recordFailure({
                node: `llm.${settings.llm.providerId}`,
                errorClass: "ModelStreamError",
                message: ev.message,
                input: { model: settings.llm.model },
              });
            }
          }

          if (failed || !calls.length) break;

          for (const c of calls) send({ t: "status", v: toolLabel(c.name) });

          const results = await Promise.all(
            calls.map(async (c) => {
              const content = await runTool(c.name, c.input ?? {}, {
                tz,
                email: session.email,
                cid: session.cid,
                signal: req.signal,
              });
              // Tool failures come back as prose so the model can explain
              // them, which means this is the only place to notice them.
              if (
                /^(Calendar unavailable|Mail unavailable|Search failed|That failed|Could not create)/.test(
                  content,
                )
              ) {
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
          send({ t: "error", v: String(e?.message ?? e).slice(0, 300) });
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
