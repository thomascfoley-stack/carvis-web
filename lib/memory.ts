import { kvEnabled, redis } from "./store";

/**
 * Durable facts JARVIS has been told to remember.
 *
 * Upstream this was SQLite with FTS5. Serverless has no local disk, so we use
 * Redis-over-HTTP when configured and degrade to an in-process list otherwise —
 * the app still runs on a fresh deploy with no extra services, it just forgets
 * when the instance recycles.
 */

const KEY = "jarvis:memories";
const MAX = 200;

let fallback: string[] = [];

export async function loadMemories(): Promise<string[]> {
  if (!kvEnabled()) return [...fallback];
  try {
    const result = await redis(["LRANGE", KEY, 0, MAX - 1]);
    return Array.isArray(result) ? result.map(String) : [];
  } catch {
    return [...fallback];
  }
}

export async function saveMemory(fact: string): Promise<boolean> {
  const clean = fact.trim().slice(0, 400);
  if (!clean) return false;

  if (!kvEnabled()) {
    if (!fallback.includes(clean)) fallback.unshift(clean);
    fallback = fallback.slice(0, MAX);
    return true;
  }

  try {
    // LREM first, so restating a fact promotes it instead of duplicating it.
    await redis(["LREM", KEY, 0, clean]);
    await redis(["LPUSH", KEY, clean]);
    await redis(["LTRIM", KEY, 0, MAX - 1]);
    return true;
  } catch {
    if (!fallback.includes(clean)) fallback.unshift(clean);
    return true;
  }
}

export async function forgetMemory(fact: string): Promise<boolean> {
  if (!kvEnabled()) {
    fallback = fallback.filter((f) => f !== fact);
    return true;
  }
  try {
    await redis(["LREM", KEY, 0, fact]);
    return true;
  } catch {
    return false;
  }
}

export async function searchMemories(query: string, limit = 8): Promise<string[]> {
  const all = await loadMemories();
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
