/**
 * Turning a tool result into something worth looking at.
 *
 * The voice and the screen want opposite things. Speech has to be ruthless —
 * "twelve unread, three matter" — because reading twelve subject lines aloud
 * is useless. A glance is the opposite: the whole list at once is *easier*
 * than a summary, because your eye picks out what matters far faster than a
 * sentence can describe it.
 *
 * So the card shows the rows and the voice keeps consolidating. This is the
 * bridge: a best-effort read of whatever a tool returned into rows a person
 * can scan.
 *
 * Deliberately forgiving. Every provider shapes its payload differently and
 * Composio wraps them again, so this looks for the shapes that actually turn
 * up and gives up gracefully rather than guessing wrong — a card with nothing
 * in it is better than a card full of confidently mislabelled fields.
 */

export type SnapshotRow = {
  /** The thing itself: a subject, an event title, an opportunity name. */
  primary: string;
  /** Who or where: a sender, a location, an account. */
  secondary?: string;
  /** When or how much: a time, an amount, a stage. */
  meta?: string;
  /** Unread mail, a declined invite — worth the eye landing here first. */
  emphasis?: boolean;
};

export type Snapshot = {
  kind: string;
  rows: SnapshotRow[];
  /** Set when the source had more than we are showing. */
  more?: number;
};

/** A card is a glance, not a spreadsheet. */
const MAX_ROWS = 12;
const MAX_LEN = 120;

const clean = (v: unknown): string =>
  typeof v === "string" || typeof v === "number"
    ? String(v).replace(/\s+/g, " ").trim().slice(0, MAX_LEN)
    : "";

/** First present key wins — providers disagree about names, not meanings. */
function pick(o: Record<string, any>, keys: string[]): string {
  for (const k of keys) {
    const direct = clean(o?.[k]);
    if (direct) return direct;
  }
  return "";
}

/** Gmail nests the interesting parts under headers or payload.headers. */
function header(o: Record<string, any>, name: string): string {
  const list = o?.payload?.headers ?? o?.headers;
  if (Array.isArray(list)) {
    const hit = list.find((h: any) => String(h?.name ?? "").toLowerCase() === name);
    if (hit) return clean(hit.value);
  }
  return clean(o?.[name]);
}

/** A person is more useful as a name than as an address with angle brackets. */
function person(raw: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(raw);
  return (m ? m[1] : raw).trim().slice(0, 60);
}

/** Google times arrive as {dateTime} or {date}; show the useful half. */
function when(v: any): string {
  const raw = typeof v === "string" ? v : clean(v?.dateTime) || clean(v?.date);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 40);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  // A date-only value has no meaningful clock reading.
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? day : `${day}, ${time}`;
}

/**
 * Find the list inside the payload.
 *
 * Composio wraps results in data/response_data, providers disagree on the
 * array's name, and some nest one level deeper again. Rather than encode
 * every combination, walk shallowly and take the first array of objects that
 * looks like content.
 */
function findRows(payload: any, depth = 0): any[] {
  if (Array.isArray(payload)) {
    return payload.filter((x) => x && typeof x === "object");
  }
  if (!payload || typeof payload !== "object" || depth > 4) return [];

  const NAMED = ["messages", "items", "events", "records", "threads", "files", "results", "data"];
  for (const k of NAMED) {
    const found = findRows(payload[k], depth + 1);
    if (found.length) return found;
  }
  for (const v of Object.values(payload)) {
    if (v && typeof v === "object") {
      const found = findRows(v, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

/** Read a row as mail, a calendar event, or something generic. */
function toRow(o: Record<string, any>): SnapshotRow | null {
  const subject = header(o, "subject") || pick(o, ["subject", "Subject"]);
  const from = person(header(o, "from") || pick(o, ["from", "sender", "From"]));
  if (subject || from) {
    const labels = Array.isArray(o?.labelIds) ? o.labelIds.map(String) : [];
    return {
      primary: subject || "(no subject)",
      secondary: from,
      meta: when(o?.internalDate ? new Date(Number(o.internalDate)).toISOString() : o?.date),
      emphasis: labels.includes("UNREAD"),
    };
  }

  const title = pick(o, ["summary", "title", "name", "Name", "subject"]);
  if (title) {
    const start = when(o?.start ?? o?.startTime ?? o?.start_time);
    const amount = pick(o, ["amount", "Amount", "value"]);
    const stage = pick(o, ["stage", "StageName", "status", "Status"]);
    return {
      primary: title,
      secondary: clean(o?.location) || pick(o, ["AccountName", "account", "organizer"]),
      meta: start || [amount, stage].filter(Boolean).join(" · "),
      // A calendar hole you have not answered is the thing worth spotting.
      emphasis: String(o?.responseStatus ?? "") === "needsAction",
    };
  }
  return null;
}

/** Best-effort. Returns null when there is nothing worth putting on screen. */
export function toSnapshot(toolName: string, resultText: string): Snapshot | null {
  if (!resultText || resultText.length > 200_000) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(resultText);
  } catch {
    // Composio often prefixes prose before the JSON body.
    const start = resultText.indexOf("{");
    const end = resultText.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      payload = JSON.parse(resultText.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const found = findRows(payload);
  if (!found.length) return null;

  const rows = found.slice(0, MAX_ROWS).map(toRow).filter(Boolean) as SnapshotRow[];
  if (!rows.length) return null;

  return {
    kind: labelFor(toolName),
    rows,
    more: found.length > rows.length ? found.length - rows.length : undefined,
  };
}

function labelFor(toolName: string): string {
  const app = String(toolName).split(/[_.]/)[0].toUpperCase();
  const PRETTY: Record<string, string> = {
    GMAIL: "Inbox",
    GOOGLECALENDAR: "Calendar",
    SALESFORCE: "Salesforce",
    SLACK: "Slack",
    GOOGLEDRIVE: "Drive",
    GOOGLESHEETS: "Sheets",
  };
  return PRETTY[app] ?? "Results";
}
