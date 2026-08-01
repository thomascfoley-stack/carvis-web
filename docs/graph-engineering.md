# Graph engineering

How CARVIS stays small and observable: every fallible step is a **node**, all
nodes share one wrapper, and every defect lands in one queue that an agent
works through daily. The point is not more machinery — it is writing the
cross-cutting plumbing (timing, failure capture, retry, redaction) exactly
once instead of smearing copies of it across handlers.

## The node contract — `lib/graph.ts`

```ts
const node = defineNode({
  id: (a) => `tool.${a.name}`,   // name in the failures table
  run: (a, ctx) => ...,          // the only code you actually write
  soft: (out) => ...,            // returned-but-broken detection (optional)
  retryOnce: (msg) => ...,       // transient-failure predicate (optional)
  sample: (a) => ...,            // the redacted reproduction (optional)
});
```

The wrapper provides, in order: timing → soft/hard failure detection →
one-shot retry for transient failures → fingerprinted capture into the
`failures` table with a redacted, capped reproduction sample. Aborts (the
user hanging up) are never captured — they are choices, not defects.

Current nodes: `tool.<MCP_TOOL>`, `tts.<provider>`, `voices.<provider>`.
The chat route's streaming boundaries (`llm.<provider>`, `chat.stream`)
capture directly via `recordFailure` — a stream of events has no single
return value for `soft` to inspect, and pretending otherwise would be
machinery for its own sake.

## Why a graph and not plain functions

A failure names a node, and a node records its input. That makes a failed
run **replayable** — the fixer agent gets a reproduction, not a stack trace.
The `failures` table fingerprints on `node : class : normalized-message`, so
one broken integration is one row with a counter, not four thousand rows.

## Practices held firm

1. **One side effect per node.** Two, and it cannot be retried safely. This
   is why `retryOnce` exists on the read-only voices node and not on tools.
2. **Golden evals for LLM behaviour, unit tests for pure functions.** The
   harness (`test/run.mjs`) runs both: real-server loop turns against mock
   providers, and direct unit suites over the deterministic library code.
3. **The fixer agent opens a PR. It never merges.** An agent that merges its
   own fixes is a slop amplifier. A human owns the merge button, always.
4. **Noise discipline.** User-configuration states never enter the failures
   table: no key yet, browser TTS selected, a 401/403 from the user's own
   BYOK key, and every flavour of abort (a hang-up is a choice, not a
   defect). It is a defect queue, not an activity log — one noisy node
   buries every real bug. The table is also bounded: fingerprint components
   are length-capped and an amortised trim keeps the most recent 2000 rows,
   because a tenant's own MCP endpoint influences node names and error text.
5. **Everything in the table is already redacted.** Messages and samples
   pass the `lib/redact.ts` scrubber at write time, so the table is safe to
   read in front of anyone and safe to quote in a PR.

## The daily fixer loop

```
failures table  ──►  GET /api/failures  ──►  daily agent  ──►  branch + PR
      ▲                (admin session)         (triage,           (human
      └──────────── recordFailure ◄─────────── never merges)      merges)
```

- **`/api/failures`** (GET queue, PATCH status) answers **404** unless the
  caller has a valid session *and* is listed in `CARVIS_ADMIN_EMAILS`. The
  env var is unset by default, which keeps the route dead until an operator
  opts in. Probes cannot distinguish it from a missing route.
- Every env var on this deployment is Sensitive (write-only), so no process
  outside Vercel can hold `DATABASE_URL`. The agent reads the queue through
  the route with an admin's signed-in browser session and holds no secrets.
- Statuses: `open → triaged → pr_open → fixed`, plus `stale` for rows not
  seen in 14 days. `recordFailure` re-opens a `fixed` row if the error
  recurs — a merged "fix" that didn't fix reappears on its own.

### Operating it

1. Set `CARVIS_ADMIN_EMAILS` to the operator addresses (Vercel env,
   production). Until then the loop is dormant by design.
2. The scheduled task `carvis-daily-fixer` (Claude Code, daily) reads the
   queue, triages, opens at most a couple of small PRs on branches named
   `fixer/<fingerprint-slug>`, and files a short report. Disable it by
   deleting the task; nothing in the deployment depends on it.
3. Treat its PRs like any contributor's: read the reproduction, run the
   harness, then merge or close.
