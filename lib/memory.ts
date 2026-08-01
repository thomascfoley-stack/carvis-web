import { dbEnabled, dbLoadMemories, dbSaveMemory, dbSearchMemories } from "./db";

/**
 * Per-user durable facts.
 *
 * Upstream this was SQLite with FTS5. Here it's Postgres full-text, scoped by
 * email so one tenant can never read another's memory. The in-process fallback
 * only exists so the app still runs before a database is attached.
 */

const MAX = 200;

const fallback = new Map<string, string[]>();

const localList = (email: string) => fallback.get(email) ?? [];

export async function loadMemories(email: string): Promise<string[]> {
  if (!email) return [];
  if (dbEnabled()) {
    try {
      return await dbLoadMemories(email);
    } catch {
      /* fall through */
    }
  }
  return [...localList(email)];
}

export async function saveMemory(email: string, fact: string): Promise<boolean> {
  const clean = fact.trim().slice(0, 400);
  if (!clean || !email) return false;

  if (dbEnabled()) {
    try {
      await dbSaveMemory(email, clean);
      return true;
    } catch {
      /* fall through */
    }
  }

  const list = localList(email).filter((f) => f !== clean);
  list.unshift(clean);
  fallback.set(email, list.slice(0, MAX));
  return true;
}

export async function searchMemories(
  email: string,
  query: string,
  limit = 8,
): Promise<string[]> {
  if (!email) return [];

  if (dbEnabled()) {
    try {
      const hits = await dbSearchMemories(email, query, limit);
      if (hits.length) return hits;
      // No full-text match is a legitimate answer, but fall back to recent
      // facts so a vaguely-worded question still gets some context.
      return (await dbLoadMemories(email, limit)).slice(0, limit);
    } catch {
      /* fall through */
    }
  }

  const all = localList(email);
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return all.slice(0, limit);

  return all
    .map((m) => {
      const lower = m.toLowerCase();
      return { m, score: terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}
