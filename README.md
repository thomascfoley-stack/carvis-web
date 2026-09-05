# CARVIS

**C**ertainly **A** **R**ather **V**ery **I**ntelligent **S**ystem — a
voice-first assistant that runs anywhere a browser does. Talk to it, it talks
back: dry British wit, an audio-reactive neural-net orb, and access to your
mail, calendar, and hundreds of other apps through your own Composio MCP
endpoint.

Cloud-native port of the macOS original
([thomascfoley-stack/jarvis](https://github.com/thomascfoley-stack/jarvis)).
AppleScript, Playwright, and local SQLite don't exist on serverless, so
integrations moved to MCP, memory moved to Postgres, and the transport moved
to streamed HTTP.

---

## The model: bring your own keys

CARVIS bills nobody. Each user signs in with Google (brokered by Composio,
identity only) and supplies three keys of their own in **Setup**:

1. **Composio MCP** — endpoint URL + API key. Every integration the assistant
   can reach comes from *your* endpoint. Tenant isolation is structural:
   the server never holds anyone else's endpoint, so there is nothing to
   accidentally cross.
2. **Model** — Anthropic, OpenAI, Groq, Gemini, DeepSeek, xAI, OpenRouter,
   Moonshot, or any custom OpenAI/Anthropic-compatible endpoint.
3. **Voice** — OpenAI, ElevenLabs, Deepgram, Cartesia, LMNT, Rime, Hume,
   Speechify, Google, Fish Audio, a custom endpoint, or the free on-device
   browser voice.

Keys are AES-GCM encrypted at rest, never returned to the browser (masked
hints only), and never appear in URLs or logs — every error surface passes
through a redaction layer first.

## What makes it fast

Time-to-first-word is the only latency number that matters in a voice app.

- Model tokens stream; a splitter cuts at real sentence boundaries (it knows
  decimals, initials, "Dr.", "e.g.") and ships each sentence to TTS the
  instant it closes. Sentences download concurrently, play strictly in order.
- The model speaks one short line *before* calling a tool, so the wait is
  spent listening.
- 6s / 17s / 34s: spoken heartbeats while a slow tool runs.
- 45s: the turn detaches — CARVIS says it will keep working, control returns
  to you, the job keeps running, and it announces the answer when it lands.
  Interrupting cannot kill a detached job.
- Tool catalogues and decrypted credentials are cached server-side with short
  TTLs, so a spoken reply costs one credential read, not one per sentence.

## What makes it not annoying

- **Consolidation contract**: never more than 2–5 items aloud; the shape is
  headline → count → offer. "Twelve unread. Three matter. Want them?"
- **You pull for detail, it never pushes.** "Tell me more" → next tier.
  "Read it out" is the only case where it may exceed the budget.
- **Interruption done properly**: barge-in stops it instantly, echo rejection
  keeps it from interrupting itself, and its memory of the reply is trimmed
  to the words that actually reached your ears.
- **No "sir".** It uses no form of address until you tell it what to call
  you — say "call me Thomas" once and it persists.

## Deploy your own

1. Import this repo into Vercel (standard Next.js, no config) and attach a
   Neon Postgres database (`DATABASE_URL`).
2. Set environment variables:

| Variable | Required | What it does |
|---|---|---|
| `COMPOSIO_API_KEY` | yes | Brokers Google sign-in only — grants no data access |
| `DATABASE_URL` | yes | Neon Postgres; schema applies itself |
| `CARVIS_AUTH_SECRET` | yes | Signs session cookies |
| `CARVIS_ENCRYPTION_KEY` | yes | Master key for credential encryption. Pick once, never rotate |
| `CARVIS_INVITE_CODE` | no | Gate signup with a shared code |
| `CARVIS_ALLOWED_EMAILS` / `CARVIS_ALLOWED_DOMAINS` | no | Harder allowlists |
| `CARVIS_ADMIN_EMAILS` | no | Operators who may read the failures queue (`/api/failures`) |

(Legacy `JARVIS_*` names are still honoured.)

3. Sign in, open **Setup**, paste your three keys, pick a voice from your own
   provider library, hit **▶ Preview**, and talk.

## Architecture

```
mic → Web Speech API → /api/chat (streaming NDJSON)
                           ↓
              model — one of two wire formats (Anthropic / OpenAI)
                           ↓
       tool calls → your Composio MCP endpoint (JSON-RPC, session-healing)
                           ↓
   sentence splitter → /api/tts (your voice key) → ordered audio queue
                           ↓
                    AnalyserNode → Three.js neural-net orb
```

| Path | Purpose |
|---|---|
| `lib/providers/llm.ts` | Registry + streaming engine, both wire formats |
| `lib/providers/tts.ts` | Registry + executor + voice-catalogue index, 12 providers |
| `lib/mcp.ts` | Minimal MCP client with session-expiry recovery |
| `lib/prompt.ts` | Persona + consolidation contract |
| `lib/sentences.ts` | Incremental sentence splitter |
| `lib/speaker.ts` | Ordered audio queue, barge-in, spoken-prefix tracking |
| `lib/credentials.ts` | Per-user BYOK, AES-GCM, provider-switch hygiene |
| `lib/crypto.ts` | Envelope encryption + master-key rotation detection |
| `lib/redact.ts` | Nothing user-visible ships without passing through this |
| `lib/graph.ts` | One wrapper for every fallible step: timing, capture, retry |
| `components/Orb.tsx` | Neural-net particle cloud (motion-safety constrained) |
| `test/run.mjs` | 780-assertion loop harness against mock providers |

## Testing

```bash
npm run build
CARVIS_ALLOW_MEMORY_CREDENTIALS=1 npx tsx test/run.mjs --rounds 2 --loop 80
```

Mock LLM/TTS/MCP servers + a production `next start`: auth boundary, key
non-leakage, chat/tool/heartbeat/detach streaming, MCP session recovery,
concurrency, aborts, tenant isolation. See `docs/scale-security-audit.md`.

Production defects land fingerprinted in the `failures` table with a
redacted reproduction; a daily agent triages the queue and opens PRs —
never merges. The node contract and that loop: `docs/graph-engineering.md`.

## Known limits

- Speech **recognition** is Chrome/Edge only (no Web Speech API on Safari).
  Text input and speech output work everywhere.
- The macOS original's AppleScript/screen-reading powers stay on macOS.

## Contributing

Bug reports, feature ideas, and PRs all welcome. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for setup and the PR checklist.

## License

MIT, see [LICENSE](./LICENSE).
