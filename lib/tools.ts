import { composioEnabled, composioExecute, condense } from "./composio";
import { saveMemory, searchMemories } from "./memory";
import type { ToolDef } from "./providers/llm";

/**
 * Every external capability routes through Composio — there are no direct
 * vendor SDKs in this app. That keeps auth in one place and means a new
 * integration is a tool definition, not a dependency.
 */

/* ---------------------------- timezone maths --------------------------- *
 * Calendar APIs filter on absolute instants. Asking a low-latency model to
 * work out "start of today in America/Chicago" is a reliable source of
 * off-by-one-day bugs, so the model only names a range and we compute the
 * real boundaries from the browser's IANA zone.
 * ----------------------------------------------------------------------- */

function zoneOffset(tz: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
    const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!m) return "+00:00";
    return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
  } catch {
    return "+00:00";
  }
}

function localMidnight(tz: string, at: Date): Date {
  try {
    // en-CA formats as YYYY-MM-DD, which parses cleanly.
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    return new Date(`${ymd}T00:00:00Z`);
  } catch {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
}

function stamp(day: Date, offset: string, endOfDay = false): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T${endOfDay ? "23:59:59" : "00:00:00"}${offset}`;
}

function calendarWindow(range: string, tz: string) {
  const now = new Date();
  const offset = zoneOffset(tz, now);
  const today = localMidnight(tz, now);
  const DAY = 86400000;

  switch (range) {
    case "tomorrow": {
      const t = new Date(today.getTime() + DAY);
      return { timeMin: stamp(t, offset), timeMax: stamp(t, offset, true) };
    }
    case "week": {
      const end = new Date(today.getTime() + 7 * DAY);
      return { timeMin: stamp(today, offset), timeMax: stamp(end, offset, true) };
    }
    case "rest_of_today":
      return { timeMin: now.toISOString(), timeMax: stamp(today, offset, true) };
    default:
      return { timeMin: stamp(today, offset), timeMax: stamp(today, offset, true) };
  }
}

/* ----------------------------- definitions ---------------------------- */

const MEMORY_TOOLS: ToolDef[] = [
  {
    name: "remember_fact",
    description:
      "Store a durable fact, preference, or decision about the user for future conversations. Only for things worth keeping.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description:
            "A standalone sentence in the third person, e.g. 'Prefers React over Vue for new projects.'",
        },
      },
      required: ["fact"],
    },
  },
  {
    name: "recall_facts",
    description: "Search previously stored facts about the user.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for." } },
      required: ["query"],
    },
  },
];

const INTEGRATION_TOOLS: ToolDef[] = [
  {
    name: "check_calendar",
    description:
      "Read the user's Google Calendar. Use for any question about their schedule, meetings, or availability.",
    input_schema: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["today", "rest_of_today", "tomorrow", "week"],
          description: "Which window to read. Defaults to today.",
        },
      },
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create an event on the user's primary calendar. Only when they clearly ask to schedule, book, or block time.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        start_datetime: {
          type: "string",
          description:
            "Local start time as ISO 8601 with no timezone suffix, e.g. '2026-08-04T14:30:00'. Natural language is rejected — resolve it from the current time in your instructions.",
        },
        duration_minutes: { type: "number", description: "Length in minutes. Default 30." },
        description: { type: "string", description: "Optional notes." },
        location: { type: "string", description: "Optional location." },
      },
      required: ["summary", "start_datetime"],
    },
  },
  {
    name: "check_email",
    description:
      "Read recent Gmail messages. Read-only by design — you cannot send, reply to, or delete mail.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search syntax, e.g. 'is:unread', 'from:alice@example.com', 'is:important newer_than:2d'. Defaults to is:unread.",
        },
        max_results: { type: "number", description: "How many to fetch. Default 12." },
      },
    },
  },
  {
    name: "search_web",
    description: "Search the live web for current information beyond your training data.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    },
  },
  {
    name: "run_integration",
    description:
      "Escape hatch for any other connected app. Executes a Composio tool by its slug. Use only when no dedicated tool above fits, and only for apps the user has connected.",
    input_schema: {
      type: "object",
      properties: {
        tool_slug: {
          type: "string",
          description: "Composio tool slug, e.g. 'SLACK_SEND_MESSAGE', 'LINEAR_LIST_ISSUES'.",
        },
        arguments: { type: "object", description: "Arguments object for that tool." },
      },
      required: ["tool_slug"],
    },
  },
];

export function toolCatalogue(): ToolDef[] {
  return composioEnabled() ? [...INTEGRATION_TOOLS, ...MEMORY_TOOLS] : MEMORY_TOOLS;
}

/** Present-tense label shown in the UI while a tool runs. */
export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    check_calendar: "Checking your calendar",
    create_calendar_event: "Scheduling that",
    check_email: "Checking your mail",
    search_web: "Searching",
    remember_fact: "Committing that to memory",
    recall_facts: "Recalling",
    run_integration: "Working",
  };
  return labels[name] ?? "Working";
}

export async function runTool(
  name: string,
  input: Record<string, any>,
  ctx: { tz: string; signal?: AbortSignal },
): Promise<string> {
  try {
    switch (name) {
      case "remember_fact":
        return (await saveMemory(String(input.fact ?? ""))) ? "Saved." : "Nothing to save.";

      case "recall_facts": {
        const hits = await searchMemories(String(input.query ?? ""));
        return hits.length ? hits.join("\n") : "No stored facts match that.";
      }

      case "check_calendar": {
        const { timeMin, timeMax } = calendarWindow(String(input.range ?? "today"), ctx.tz);
        const res = await composioExecute(
          "GOOGLECALENDAR_EVENTS_LIST",
          {
            calendarId: "primary",
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 25,
            timeZone: ctx.tz,
          },
          ctx.signal,
        );
        if (!res.ok) return `Calendar unavailable: ${res.error}`;
        return summariseEvents(res.data) ?? condense(res.data);
      }

      case "create_calendar_event": {
        const mins = Math.max(1, Math.round(Number(input.duration_minutes ?? 30)));
        const res = await composioExecute(
          "GOOGLECALENDAR_CREATE_EVENT",
          {
            calendar_id: "primary",
            summary: String(input.summary ?? "Untitled"),
            start_datetime: String(input.start_datetime ?? ""),
            // The API rejects a minutes value of 60 or more, so split it.
            event_duration_hour: Math.floor(mins / 60),
            event_duration_minutes: mins % 60,
            timezone: ctx.tz,
            ...(input.description ? { description: String(input.description) } : {}),
            ...(input.location ? { location: String(input.location) } : {}),
          },
          ctx.signal,
        );
        return res.ok ? "Event created." : `Could not create the event: ${res.error}`;
      }

      case "check_email": {
        const res = await composioExecute(
          "GMAIL_FETCH_EMAILS",
          {
            query: String(input.query ?? "is:unread"),
            max_results: Math.min(25, Math.max(1, Number(input.max_results ?? 12))),
            verbose: false,
            include_payload: false,
          },
          ctx.signal,
        );
        if (!res.ok) return `Mail unavailable: ${res.error}`;
        return summariseEmails(res.data) ?? condense(res.data);
      }

      case "search_web": {
        const res = await composioExecute(
          "COMPOSIO_SEARCH_WEB",
          { query: String(input.query ?? "") },
          ctx.signal,
        );
        return res.ok ? condense(res.data, 2500) : `Search failed: ${res.error}`;
      }

      case "run_integration": {
        const slug = String(input.tool_slug ?? "").trim().toUpperCase();
        if (!slug) return "No tool slug given.";
        const res = await composioExecute(slug, (input.arguments ?? {}) as any, ctx.signal);
        return res.ok ? condense(res.data, 2500) : `That failed: ${res.error}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error: ${String(e).slice(0, 200)}`;
  }
}

/* ------------------------------- shaping ------------------------------ *
 * Flattening payloads here is part of the consolidation strategy: the model
 * answers better from a short ranked list than from raw API JSON.
 * ---------------------------------------------------------------------- */

function pickArray(data: any, ...keys: string[]): any[] | null {
  for (const k of keys) {
    const v = data?.[k] ?? data?.response_data?.[k] ?? data?.data?.[k];
    if (Array.isArray(v)) return v;
  }
  return Array.isArray(data) ? data : null;
}

function summariseEvents(data: any): string | null {
  const items = pickArray(data, "items", "events");
  if (!items) return null;
  if (!items.length) return "No events in that window.";

  const lines = items.slice(0, 25).map((e: any) => {
    const start = e?.start?.dateTime ?? e?.start?.date ?? "";
    const title = e?.summary ?? "(no title)";
    const where = e?.location ? ` at ${e.location}` : "";
    const who = Array.isArray(e?.attendees) ? ` [${e.attendees.length} attendees]` : "";
    return `${start} — ${title}${where}${who}`;
  });
  return `${items.length} event(s):\n${lines.join("\n")}`;
}

/** Cheap importance signal so the model has something to rank on. */
function emailPriority(m: any): number {
  const labels: string[] = Array.isArray(m?.labelIds) ? m.labelIds : m?.labels ?? [];
  const set = new Set(labels.map((l: string) => String(l).toUpperCase()));
  let score = 0;
  if (set.has("IMPORTANT")) score += 3;
  if (set.has("STARRED")) score += 3;
  if (set.has("CATEGORY_PERSONAL") || set.has("CATEGORY_PRIMARY")) score += 2;
  if (set.has("CATEGORY_PROMOTIONS") || set.has("CATEGORY_SOCIAL")) score -= 3;
  if (set.has("CATEGORY_UPDATES") || set.has("CATEGORY_FORUMS")) score -= 2;

  const from = String(m?.sender ?? m?.from ?? "").toLowerCase();
  if (/no-?reply|newsletter|notifications?@|mailer|marketing/.test(from)) score -= 3;
  return score;
}

function summariseEmails(data: any): string | null {
  const items = pickArray(data, "messages", "emails");
  if (!items) return null;
  if (!items.length) return "No messages match.";

  const ranked = [...items].sort((a, b) => emailPriority(b) - emailPriority(a));
  const lines = ranked.slice(0, 20).map((m: any) => {
    const from = m?.sender ?? m?.from ?? m?.From ?? "unknown sender";
    const subject = m?.subject ?? m?.Subject ?? "(no subject)";
    const preview = m?.snippet ? ` — ${String(m.snippet).slice(0, 120)}` : "";
    const flag = emailPriority(m) >= 3 ? "[priority] " : "";
    return `${flag}From ${from}: ${subject}${preview}`;
  });

  return [
    `${items.length} message(s), ranked by likely importance.`,
    "Speak only the top few and give a count for the rest.",
    ...lines,
  ].join("\n");
}
