import { neon } from "@neondatabase/serverless";
import { redact } from "./redact";

/**
 * Neon Postgres.
 *
 * This exists because the app is multi-tenant. With a single user, environment
 * variables were enough. With open signup we need three things env vars cannot
 * give us: a per-user Composio identity (so one person's Gmail is never
 * readable by another), per-user memory, and usage counters to stop one
 * account running up the whole bill.
 *
 * Uses Neon's HTTP driver so it works on the Edge runtime.
 */

const url =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  "";

export const dbEnabled = () => !!url;

/**
 * One client per instance. neon() is only an HTTP wrapper, but building it on
 * every query re-parses the DSN and re-allocates fetch options — measurable on
 * a hot path that runs per sentence.
 */
let cached: ReturnType<typeof neon> | null = null;

function client() {
  if (!url) throw new Error("No DATABASE_URL configured");
  if (!cached) cached = neon(url);
  return cached;
}

/* ------------------------------ schema ------------------------------- */

let schemaReady: Promise<void> | null = null;

/**
 * Schema version. Bump when the DDL below changes shape; the fast-path probe
 * skips every CREATE statement when the stored version already matches.
 */
const SCHEMA_VERSION = 3;

/**
 * Idempotent, lazily applied once per warm instance.
 *
 * The probe matters at scale: with thousands of lambda cold starts a minute,
 * "a dozen CREATE TABLE IF NOT EXISTS on every cold start" becomes a steady
 * stream of catalog-lock traffic on the database. One SELECT against a
 * version row is the cheap path; DDL only runs when the version is behind.
 */
export function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const sql = client();

    try {
      const rows = (await sql`
        SELECT version FROM schema_meta LIMIT 1
      `) as unknown as { version: number }[];
      if ((rows[0]?.version ?? 0) >= SCHEMA_VERSION) return;
    } catch {
      /* table missing — first boot, fall through to DDL */
    }

    await sql`
      CREATE TABLE IF NOT EXISTS users (
        email             TEXT PRIMARY KEY,
        composio_user_id  TEXT NOT NULL UNIQUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        status            TEXT NOT NULL DEFAULT 'active',
        daily_limit       INTEGER NOT NULL DEFAULT 50
      )`;

    await sql`
      CREATE TABLE IF NOT EXISTS usage_daily (
        email      TEXT NOT NULL,
        day        DATE NOT NULL,
        messages   INTEGER NOT NULL DEFAULT 0,
        tts_chars  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (email, day)
      )`;

    await sql`
      CREATE TABLE IF NOT EXISTS memory (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT NOT NULL,
        fact        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS memory_email_idx ON memory (email, created_at DESC)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_unique_idx ON memory (email, fact)`;

    await sql`
      CREATE TABLE IF NOT EXISTS user_prefs (
        email       TEXT PRIMARY KEY,
        prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;

    // Per-user credentials. Secret columns hold AES-GCM ciphertext, never
    // plaintext — see lib/crypto.ts.
    await sql`
      CREATE TABLE IF NOT EXISTS user_credentials (
        email       TEXT PRIMARY KEY,
        creds       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;

    // Voice libraries fetched from each provider with the user's own key.
    // Cached because it's a slow third-party round trip on a page people open
    // to change one field, and because a cloned-voice library is stable.
    await sql`
      CREATE TABLE IF NOT EXISTS voice_cache (
        email       TEXT NOT NULL,
        provider    TEXT NOT NULL,
        voices      JSONB NOT NULL DEFAULT '[]'::jsonb,
        fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (email, provider)
      )`;

    // Failure capture for the fixer agent. Fingerprinted so one broken
    // integration is a single row with a counter, not 4000 duplicates.
    await sql`
      CREATE TABLE IF NOT EXISTS failures (
        fingerprint  TEXT PRIMARY KEY,
        node         TEXT NOT NULL,
        error_class  TEXT NOT NULL,
        message      TEXT NOT NULL,
        sample_input JSONB,
        occurrences  INTEGER NOT NULL DEFAULT 1,
        first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
        status       TEXT NOT NULL DEFAULT 'open'
      )`;
    await sql`CREATE INDEX IF NOT EXISTS failures_status_idx ON failures (status, last_seen DESC)`;

    await sql`
      CREATE TABLE IF NOT EXISTS schema_meta (
        singleton  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
        version    INTEGER NOT NULL
      )`;
    await sql`
      INSERT INTO schema_meta (singleton, version) VALUES (true, ${SCHEMA_VERSION})
      ON CONFLICT (singleton) DO UPDATE SET version = ${SCHEMA_VERSION}
    `;
  })().catch((e) => {
    // Let the next request retry rather than wedging a bad promise forever.
    schemaReady = null;
    throw e;
  });

  return schemaReady;
}

/* ------------------------------- users -------------------------------- */

export type UserRow = {
  email: string;
  composio_user_id: string;
  status: string;
  daily_limit: number;
};

export async function findUser(email: string): Promise<UserRow | null> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    SELECT email, composio_user_id, status, daily_limit
    FROM users WHERE email = ${email.toLowerCase()}
  `) as unknown as UserRow[];
  return rows[0] ?? null;
}

/** Called on every successful login. Creates the row the first time. */
export async function upsertUser(email: string, composioUserId: string): Promise<UserRow> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    INSERT INTO users (email, composio_user_id)
    VALUES (${email.toLowerCase()}, ${composioUserId})
    ON CONFLICT (email) DO UPDATE SET last_seen_at = now()
    RETURNING email, composio_user_id, status, daily_limit
  `) as unknown as UserRow[];
  return rows[0];
}

/* ------------------------------- quotas ------------------------------- */

export type Quota = { allowed: boolean; used: number; limit: number };

/**
 * Atomically increments today's counter and reports whether the caller is
 * still under their cap. Counting before the work happens is deliberate: it
 * fails closed if the model call later errors, which is the safer direction
 * when someone else's key is paying.
 */
export async function consumeMessage(email: string, limit: number): Promise<Quota> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    INSERT INTO usage_daily (email, day, messages)
    VALUES (${email.toLowerCase()}, CURRENT_DATE, 1)
    ON CONFLICT (email, day) DO UPDATE SET messages = usage_daily.messages + 1
    RETURNING messages
  `) as unknown as { messages: number }[];

  const used = rows[0]?.messages ?? 0;
  return { allowed: used <= limit, used, limit };
}

export async function addTtsChars(email: string, chars: number): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql`
    INSERT INTO usage_daily (email, day, tts_chars)
    VALUES (${email.toLowerCase()}, CURRENT_DATE, ${chars})
    ON CONFLICT (email, day) DO UPDATE SET tts_chars = usage_daily.tts_chars + ${chars}
  `;
}

export async function todayUsage(email: string): Promise<{ messages: number; tts_chars: number }> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    SELECT messages, tts_chars FROM usage_daily
    WHERE email = ${email.toLowerCase()} AND day = CURRENT_DATE
  `) as unknown as { messages: number; tts_chars: number }[];
  return rows[0] ?? { messages: 0, tts_chars: 0 };
}

/* ------------------------------- memory ------------------------------- */

export async function dbLoadMemories(email: string, limit = 40): Promise<string[]> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    SELECT fact FROM memory WHERE email = ${email.toLowerCase()}
    ORDER BY created_at DESC LIMIT ${limit}
  `) as unknown as { fact: string }[];
  return rows.map((r) => r.fact);
}

/** Hard per-user cap. Memory is a working set, not an archive. */
const MEMORY_CAP = 500;

export async function dbSaveMemory(email: string, fact: string): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql`
    INSERT INTO memory (email, fact) VALUES (${email.toLowerCase()}, ${fact})
    ON CONFLICT (email, fact) DO UPDATE SET created_at = now()
  `;

  // Amortised trim: 1-in-20 saves pays for the DELETE that keeps any single
  // user's memory bounded. Unbounded per-user rows is how a table quietly
  // becomes the reason the whole app got slow at scale.
  if (Math.random() < 0.05) {
    await sql`
      DELETE FROM memory
      WHERE email = ${email.toLowerCase()}
        AND id NOT IN (
          SELECT id FROM memory WHERE email = ${email.toLowerCase()}
          ORDER BY created_at DESC LIMIT ${MEMORY_CAP}
        )
    `.catch(() => undefined);
  }
}

export async function dbSearchMemories(
  email: string,
  query: string,
  limit = 8,
): Promise<string[]> {
  await ensureSchema();
  const sql = client();
  // Postgres full-text beats the substring matching the KV fallback used, and
  // gives us a real ranking. pgvector can slot in here later without changing
  // any caller.
  const rows = (await sql`
    SELECT fact FROM memory
    WHERE email = ${email.toLowerCase()}
      AND to_tsvector('english', fact) @@ plainto_tsquery('english', ${query})
    ORDER BY ts_rank(to_tsvector('english', fact), plainto_tsquery('english', ${query})) DESC
    LIMIT ${limit}
  `) as unknown as { fact: string }[];
  return rows.map((r) => r.fact);
}

/* ------------------------------- prefs -------------------------------- */

export async function dbLoadPrefs(email: string): Promise<unknown | null> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    SELECT prefs FROM user_prefs WHERE email = ${email.toLowerCase()}
  `) as unknown as { prefs: unknown }[];
  return rows[0]?.prefs ?? null;
}

export async function dbSavePrefs(email: string, prefs: unknown): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql`
    INSERT INTO user_prefs (email, prefs, updated_at)
    VALUES (${email.toLowerCase()}, ${JSON.stringify(prefs)}::jsonb, now())
    ON CONFLICT (email) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()
  `;
}

/* ---------------------------- credentials ----------------------------- */

export async function dbLoadCredentials(email: string): Promise<unknown | null> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    SELECT creds FROM user_credentials WHERE email = ${email.toLowerCase()}
  `) as unknown as { creds: unknown }[];
  return rows[0]?.creds ?? null;
}

export async function dbSaveCredentials(email: string, creds: unknown): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql`
    INSERT INTO user_credentials (email, creds, updated_at)
    VALUES (${email.toLowerCase()}, ${JSON.stringify(creds)}::jsonb, now())
    ON CONFLICT (email) DO UPDATE SET creds = EXCLUDED.creds, updated_at = now()
  `;
}

/* ---------------------------- voice cache ----------------------------- */

export async function dbLoadVoices(
  email: string,
  provider: string,
): Promise<{ voices: unknown; fetchedAt: string } | null> {
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    SELECT voices, fetched_at FROM voice_cache
    WHERE email = ${email.toLowerCase()} AND provider = ${provider}
  `) as unknown as { voices: unknown; fetched_at: string }[];
  const row = rows[0];
  return row ? { voices: row.voices, fetchedAt: String(row.fetched_at) } : null;
}

export async function dbSaveVoices(
  email: string,
  provider: string,
  voices: unknown,
): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql`
    INSERT INTO voice_cache (email, provider, voices, fetched_at)
    VALUES (${email.toLowerCase()}, ${provider}, ${JSON.stringify(voices)}::jsonb, now())
    ON CONFLICT (email, provider) DO UPDATE
      SET voices = EXCLUDED.voices, fetched_at = now()
  `;
}

/* ------------------------------ failures ------------------------------ */

/**
 * The reproduction sample passes through the same scrubber as every message,
 * because a tool input can quote an upstream error that quotes a key. Redaction
 * or truncation can break the JSON; when it does, the result is wrapped rather
 * than dropped — a mangled reproduction still beats none.
 */
export function safeSampleJson(input: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(input ?? null) ?? "null";
  } catch {
    raw = "null";
  }
  const safe = redact(raw).slice(0, 2000);
  try {
    JSON.parse(safe);
    return safe;
  } catch {
    return JSON.stringify({ redacted: safe });
  }
}

export async function recordFailure(args: {
  node: string;
  errorClass: string;
  message: string;
  input?: unknown;
}): Promise<void> {
  if (!dbEnabled()) return;
  try {
    await ensureSchema();
    const sql = client();

    // Strip digits and quoted literals so "user 123 not found" and
    // "user 456 not found" collapse to one fingerprint. Node names and error
    // text can be influenced by a tenant's own MCP endpoint, so both the node
    // component and the whole key are capped — cardinality is an attack
    // surface here, not just an aesthetic.
    const node = args.node.slice(0, 80);
    const clean = redact(args.message);
    const normalized = clean
      .replace(/\d+/g, "N")
      .replace(/'[^']*'/g, "'X'")
      .replace(/"[^"]*"/g, '"X"')
      .slice(0, 200);
    const fingerprint = `${node}:${args.errorClass.slice(0, 40)}:${normalized}`.slice(0, 300);

    await sql`
      INSERT INTO failures (fingerprint, node, error_class, message, sample_input)
      VALUES (${fingerprint}, ${node}, ${args.errorClass.slice(0, 40)}, ${clean.slice(0, 2000)},
              ${safeSampleJson(args.input)}::jsonb)
      ON CONFLICT (fingerprint) DO UPDATE
        SET occurrences = failures.occurrences + 1,
            last_seen   = now(),
            -- 'fixed' and 'stale' both claim "this stopped happening" — a
            -- recurrence disproves either, so both reopen.
            status      = CASE WHEN failures.status IN ('fixed', 'stale')
                               THEN 'open' ELSE failures.status END
    `;

    // Amortised trim, same idiom as the memory cap: a tenant pointing their
    // MCP endpoint at a random-error generator must not grow this table
    // without bound. Keep the most recent distinct fingerprints.
    if (Math.random() < 0.02) {
      await sql`
        DELETE FROM failures
        WHERE fingerprint NOT IN (
          SELECT fingerprint FROM failures ORDER BY last_seen DESC LIMIT 2000
        )
      `.catch(() => undefined);
    }
  } catch {
    // Never let telemetry break the request it is observing.
  }
}

export type FailureRow = {
  fingerprint: string;
  node: string;
  error_class: string;
  message: string;
  sample_input: unknown;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  status: string;
};

/** The fixer agent's queue. `status=all` is for the human reading over its shoulder. */
export async function listFailures(status: "open" | "all"): Promise<FailureRow[]> {
  if (!dbEnabled()) return [];
  await ensureSchema();
  const sql = client();
  const rows = (await (status === "all"
    ? sql`SELECT * FROM failures ORDER BY last_seen DESC LIMIT 200`
    : sql`SELECT * FROM failures WHERE status = 'open' ORDER BY occurrences DESC, last_seen DESC LIMIT 100`)) as unknown as FailureRow[];
  return rows;
}

export const FAILURE_STATUSES = ["open", "triaged", "pr_open", "fixed", "stale"] as const;

export async function setFailureStatus(fingerprint: string, status: string): Promise<boolean> {
  if (!dbEnabled()) return false;
  if (!(FAILURE_STATUSES as readonly string[]).includes(status)) return false;
  await ensureSchema();
  const sql = client();
  const rows = (await sql`
    UPDATE failures SET status = ${status} WHERE fingerprint = ${fingerprint} RETURNING fingerprint
  `) as unknown as { fingerprint: string }[];
  return rows.length > 0;
}
