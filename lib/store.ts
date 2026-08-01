/**
 * Redis-over-HTTP helper, plus the provider setting shapes.
 *
 * Provider settings used to live here globally. They are now per-user (see
 * credentials.ts and prefs.ts, both backed by Neon), so all that remains is
 * the optional KV client and the types the provider engines take.
 */

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

export const kvEnabled = () => !!(KV_URL && KV_TOKEN);

export async function redis(command: unknown[]): Promise<any> {
  if (!kvEnabled()) throw new Error("KV not configured");
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  return (await res.json())?.result;
}

export type { Prefs } from "./prefs";

export type LlmSettings = {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
};

export type TtsSettings = {
  providerId: string;
  voiceId: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};
