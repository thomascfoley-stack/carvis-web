import { sessionFromRequest } from "@/lib/auth";
import { CredentialsUnavailable, loadCredentials } from "@/lib/credentials";
import { recordFailure } from "@/lib/db";
import { loadMemories } from "@/lib/memory";
import { withUserId } from "@/lib/mcp";
import { ensureFreshMcpAuth } from "@/lib/mcpauth";
import { loadPrefs } from "@/lib/prefs";
import { systemPrompt } from "@/lib/prompt";
import { streamLLM, type CanonMsg, type ToolCall } from "@/lib/providers/llm";
import { redact } from "@/lib/redact";
import { toSnapshot } from "@/lib/snapshot";
import { buildCatalogue, runTool, toolLabel } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tool work is the slow part, and some of it is genuinely slow. Ask the host
 * for the longest window it will give us; anything past this is beyond what a
 * request-scoped worker can finish, and we say so rather than hang.
 */
export const maxDuration = 300;

// Composio's MCP works search-first: find the tool, sometimes fetch its
// schema, then execute — a legitimate email answer can take four calls
// before the model has anything to say. Six covers that with headroom.
const MAX_TOOL_ROUNDS = 6;
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
  let stored;
  try {
    stored = await ensureFreshMcpAuth(session.email, await loadCredentials(session.email));
  } catch (e) {
    // "We could not read your settings" is not "you have no settings". The
    // 428 below sends the browser to /setup, so answering it here threw
    // onboarded users out of a conversation over a transient database blip.
    if (e instanceof CredentialsUnavailable) {
      return Response.json(
        { error: "Can't reach your settings right now — try that again in a moment." },
        { status: 503 },
      );
    }
    throw e;
  }
  // An OAuth-connected endpoint authenticates with the user's token (which
  // rides the composioKey slot — the client sends JWTs as Bearer). Key-based
  // Composio URLs still get the session's user id appended.
  const creds = {
    ...stored,
    mcpUrl: stored.mcpToken ? stored.mcpUrl : withUserId(stored.mcpUrl, session.cid),
    composioKey: stored.mcpToken || stored.composioKey,
  };
  if (!creds.llmKey) {
    return Response.json(
      { error: "No model key yet. Add yours in Setup.", needsOnboarding: true },
      { status: 428 },
    );
  }

  const [memories, prefs, catalogue] = await Promise.all([
    loadMemories(session.email),
    loadPrefs(session.email),
    buildCatalogue(creds, session.email, req.signal),
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
      /** Tool results are in hand but the model has not yet spoken to them. */
      let pendingResults = false;

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
              // Same noise discipline as the graph nodes: a hang-up mid-fetch
              // and the user's own bad key (401/403) are not app defects.
              if (
                !req.signal.aborted &&
                !/abort/i.test(ev.message) &&
                !/\b40[13]\b/.test(ev.message)
              ) {
                await recordFailure({
                  node: `llm.${creds.llmProvider}`,
                  errorClass: "ModelStreamError",
                  message: ev.message,
                  input: { model: creds.llmModel },
                });
              }
            }
          }

          if (failed || !calls.length) {
            // The model answered without reaching for another tool, so it has
            // already spoken to whatever results were outstanding. Leaving the
            // flag set here would run the closing pass below and say the whole
            // answer a second time.
            pendingResults = false;
            break;
          }

          for (const c of calls) send({ t: "status", v: toolLabel(c.name) });

          // The card shows the rows; the voice keeps consolidating. Reading
          // twelve subject lines aloud is useless, but showing twelve is
          // faster to take in than any sentence describing them.

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
              // Failure capture lives inside runTool's graph node now.
              const snapshot = toSnapshot(c.name, content);
              if (snapshot) send({ t: "card", v: snapshot });
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
          pendingResults = true;
          send({ t: "status", v: "" });
        }

        // Running out of rounds mid-chain used to end the turn on raw tool
        // output with nothing said — the user simply got silence. One more
        // pass with the tools withheld forces a spoken answer from what we
        // already have.
        if (pendingResults) {
          for await (const ev of streamLLM({
            settings: {
              providerId: creds.llmProvider,
              model: creds.llmModel,
              apiKey: creds.llmKey,
              baseUrl: creds.llmBaseUrl || undefined,
            },
            system,
            messages,
            tools: [],
            signal: req.signal,
          })) {
            if (ev.type === "text") send({ t: "text", v: ev.text });
            else if (ev.type === "error") send({ t: "error", v: redact(ev.message) });
          }
        }

        send({ t: "done" });
      } catch (e: any) {
        if (e?.name !== "AbortError" && !req.signal.aborted) {
          send({ t: "error", v: redact(e?.message ?? e).slice(0, 300) });
          await recordFailure({
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
