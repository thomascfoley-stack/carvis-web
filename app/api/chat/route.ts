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

/**
 * Tool work is the slow part, and some of it is genuinely slow. Ask the host
 * for the longest window it will give us; anything past this is beyond what a
 * request-scoped worker can finish, and we say so rather than hang.
 */
export const maxDuration = 300;

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY = 16;

/**
 * Waiting in silence is the thing that makes an assistant feel broken.
 *
 * These are spoken, not printed, and they're timer-driven rather than
 * event-driven because a tool call reports nothing until it returns. The
 * wording escalates so a long wait doesn't sound like a loop, and there are
 * only three of them — past that, repeating yourself is worse than silence.
 */
const HEARTBEATS: { at: number; say: string }[] = [
  { at: 6_000, say: "Still working on that." },
  { at: 17_000, say: "This one is taking a moment. Still going." },
  { at: 34_000, say: "Still running — I will speak up the moment it lands." },
];

/**
 * Past this we stop making the user wait. The work continues on the same open
 * stream; the client simply stops treating the turn as blocking, so they can
 * say something else and the job is unaffected by them interrupting.
 */
const DETACH_AT = 45_000;

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
      // tool list was capped, the user should know why CARVIS seems limited.
      if (catalogue.note) send({ t: "note", v: catalogue.note });

      const messages: CanonMsg[] = [...history];
      /** True while the user has been handed back control mid-tool. */
      let detached = false;

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
              baseUrl: creds.llmBaseUrl || undefined,
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

          const work = Promise.all(
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

          // Talk to the user while we wait. Timers are cleared the instant the
          // work lands, so a fast tool says nothing at all.
          const label = toolLabel(calls[0]?.name ?? "");
          const timers = HEARTBEATS.map((h) => setTimeout(() => send({ t: "say", v: h.say }), h.at));
          const detachTimer = setTimeout(() => {
            detached = true;
            send({
              t: "detach",
              v: {
                label,
                say: "That one is going to take a while. I will keep it running and tell you when it is done — carry on, I am listening.",
              },
            });
          }, DETACH_AT);

          let results;
          try {
            results = await work;
          } finally {
            for (const t of timers) clearTimeout(t);
            clearTimeout(detachTimer);
          }

          // Coming back after a handoff needs a lead-in, or the answer arrives
          // with no indication of which question it belongs to.
          if (detached) {
            send({ t: "resumed", v: { say: `Right — ${label.toLowerCase()} is done.` } });
            detached = false;
          }

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
