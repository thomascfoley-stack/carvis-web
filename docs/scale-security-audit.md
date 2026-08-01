# CARVIS — scale & security audit

Date: 2026-07-31 · Scope: every SQL statement, credential path, and tenant
boundary in the codebase, reviewed against a 10M-user target. Items marked
**fixed** shipped in this pass; **later** items are structural work worth a
deliberate design session.

## Verdict in one paragraph

The data layer is sound for multi-tenancy: every table is keyed or scoped by
`email`, secrets are AES-GCM ciphertext under a server-held master key, and
nothing returns key material to the browser — masked hints only, enforced by
test. The gaps found were about *scale behaviour* (per-cold-start DDL, per-
sentence decrypts, per-turn MCP round trips) and two security tightenings
(SSRF validation on user-supplied endpoints, a bearer-token redaction gap).
All are fixed. The remaining structural work is usage accounting and memory
ranking, which the product doesn't depend on today.

## Tenant isolation

| Check | Status |
|---|---|
| Every query scoped by lowercased `email` (PK or indexed column) | ✅ verified, all 14 query sites |
| Session = HMAC-SHA256 cookie, constant-time compare, expiry enforced | ✅ + forged/tampered/expired covered by tests |
| Per-user Composio identity (`cid`) opaque, never derived from email | ✅ |
| MCP tenant isolation is structural — we never hold another user's endpoint | ✅ |
| Cross-tenant reads impossible via API (user B sees empty creds) | ✅ test-enforced |

## Credential security

| Check | Status |
|---|---|
| Secrets encrypted at rest (AES-GCM, v1.iv.ct envelope, random IV per write) | ✅ |
| Master-key rotation detected via `_kid` stamp; Setup explains instead of silently showing "not set" | ✅ |
| No key material in any response body (masked `{set, hint}` only) | ✅ test-enforced |
| No secrets in URLs; login errors pass `safeMessage()` (redact + cap) | ✅ |
| `Bearer <token>` redaction gap (rule consumed the word "Bearer", left the token) | ✅ **fixed** |
| Keyed-provider descriptors transmit key via header, never logged | ✅ test iterates all 12 providers |
| SSRF: custom LLM/TTS base URLs must be https + non-private (blocks 127.0.0.1, RFC1918, 169.254.169.254 metadata) | ✅ **fixed** |
| SSRF: user MCP URL now passes the same validation | ✅ **fixed** |
| Cookies HttpOnly + Secure + SameSite=Lax | ✅ |
| Health endpoint: presence booleans only for anonymous callers | ✅ test-enforced |

## Scale to 10M users

| Finding | Status |
|---|---|
| `ensureSchema` ran ~12 DDL statements on **every cold start** — catalog-lock traffic at fleet scale | ✅ **fixed**: `schema_meta` version probe; DDL only when behind |
| `neon(url)` client rebuilt per query | ✅ **fixed**: memoised per instance |
| Credentials read + 3 AES decrypts **per TTS sentence** (≈6 DB reads per spoken reply) | ✅ **fixed**: 30s TTL cache, invalidated on save |
| Full MCP `tools/list` round trip on **every chat turn** before the model could start | ✅ **fixed**: 5-min catalogue cache keyed by endpoint |
| `memory` unbounded per user | ✅ **fixed**: 500-row cap, amortised trim (1-in-20 writes) |
| Indexes: `memory(email, created_at DESC)`, unique `(email,fact)`, `failures(status, last_seen)`, PKs everywhere else | ✅ adequate |
| `failures` bounded: fingerprint collapse + capped components + 2000-row amortised trim | ✅ **fixed** (graph pass) |
| MCP session expiry: single-flight handshake + bounded retry (was: one expiry poisoned the warm instance) | ✅ **fixed** |

## Later (structural, flagged not fixed)

- **Usage accounting**: `usage_daily` grows one row per user per active day —
  fine to ~1M MAU, then it wants monthly rollups + a 90-day raw retention
  window. The quota functions are currently unused (BYOK) — decide whether
  usage is analytics or enforcement before structuring it.
- **Memory ranking**: full-text `ts_rank` per query is fine at 500 rows/user;
  a pgvector column + expression index slots in behind `dbSearchMemories`
  without changing any caller.
- **Rate limiting**: BYOK means runaway cost lands on the user's own keys, but
  our DB/MCP still absorbs the load. A per-email sliding window in front of
  `/api/chat` is the next cheap win; a shared store (Upstash) if multi-region.
- **Encryption key hygiene**: master key falls back to `COMPOSIO_API_KEY`.
  Set a dedicated `CARVIS_ENCRYPTION_KEY` and never rotate it (rotation is
  detected and explained, but still forces every user to re-enter keys).

## Test evidence

`test/run.mjs` — mock LLM (both wire formats), mock TTS, mock MCP with
session-expiry and slow-tool modes, against a production `next start`:
780+ assertions across redaction, splitting, crypto, credentials, prompt,
provider descriptors, voice-list parsers, MCP recovery, catalogue caps,
auth boundary, key non-leakage, chat/tool/heartbeat/detach streaming,
concurrency, aborts, and tenant isolation. `test/results.json` holds the
latest run.
