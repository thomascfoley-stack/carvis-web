import { neon } from "@neondatabase/serverless";

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

function client() {
  if (!url) throw new Error("No DATABASE_URL configured");
  return neon(url);
}

/* ------------------------------ schema ------------------------------- */

let schemaReady: Promise<void> | null = null;

/**
 * Idempotent, lazily applied once per warm instance. Avoids a separate
 * migration step at the cost of one cheap round trip on a cold start.
 */
export function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const sql = client();

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

export async function dbSaveMemory(email: string, fact: string): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql`
    INSERT INTO memory (email, fact) VALUES (${email.toLowerCase()}, ${fact})
    ON CONFLICT (email, fact) DO UPDATE SET created_at = now()
  `;
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

/* ------------------------------ failures ------------------------------ */

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
    // "user 456 not found" collapse to one fingerprint.
    const normalized = args.message.replace(/\d+/g, "N").replace(/'[^']*'/g, "'X'").slice(0, 200);
    const fingerprint = `${args.node}:${args.errorClass}:${normalized}`.slice(0, 300);

    await sql`
      INSERT INTO failures (fingerprint, node, error_class, message, sample_input)
      VALUES (${fingerprint}, ${args.node}, ${args.errorClass}, ${args.message.slice(0, 2000)},
              ${JSON.stringify(args.input ?? null)}::jsonb)
      ON CONFLICT (fingerprint) DO UPDATE
        SET occurrences = failures.occurrences + 1,
            last_seen   = now(),
            status      = CASE WHEN failures.status = 'fixed' THEN 'open' ELSE failures.status END
    `;
  } catch {
    // Never let telemetry break the request it is observing.
  }
}
