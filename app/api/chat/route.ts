import { composioEnabled } from "@/lib/composio";
import { loadMemories } from "@/lib/memory";
import { systemPrompt } from "@/lib/prompt";
import { streamLLM, type CanonMsg, type ToolCall } from "@/lib/providers/llm";
import { getSettings } from "@/lib/store";
import { runTool, toolCatalogue, toolLabel } from "@/lib/tools";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY = 16;

const encoder = new TextEncoder();
/** One JSON object per line, so the browser can act on each token as it lands. */
const frame = (obj: unknown) => encoder.encode(JSON.stringify(obj) + "\n");

export async function POST(req: Request) {
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

  const settings = await getSettings();
  if (!settings.llm.apiKey) {
    return Response.json(
      { error: "No model API key configured. Add one in Settings." },
      { status: 503 },
    );
  }

  const memories = await loadMemories();
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
            }
          }

          if (failed || !calls.length) break;

          for (const c of calls) send({ t: "status", v: toolLabel(c.name) });

          const results = await Promise.all(
            calls.map(async (c) => ({
              id: c.id,
              name: c.name,
              content: await runTool(c.name, c.input ?? {}, { tz, signal: req.signal }),
            })),
          );

          messages.push({ role: "assistant", text, toolCalls: calls });
          messages.push({ role: "tool", results });
          send({ t: "status", v: "" });
        }

        send({ t: "done" });
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          send({ t: "error", v: String(e?.message ?? e).slice(0, 300) });
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
