# StudyClaw Handoff

Last updated: 2026-04-01

## What StudyClaw Is

A WhatsApp study buddy for college students. Connects to Canvas LMS for assignments/grades, Google Calendar for scheduling, and sends proactive nudges (morning briefs, deadline warnings, weekly previews). Built on Express + Baileys (WhatsApp Web) + Anthropic Claude. OpenClaw is installed as a dependency but only used for its session/memory storage APIs — the gateway runtime is not used.

## Architecture

```
server/index.js          — Express entry point, starts WhatsApp + cron
server/sms-handler.js    — Main message handler, tool execution, onboarding, memory extraction
server/cron-runner.js    — Morning brief, deadline checks, weekly preview, Canvas refresh, memory curation + pattern analysis
server/whatsapp-listener.js — Baileys WhatsApp connection, message routing
server/oauth-google.js   — Google Calendar OAuth callback
server/routes.js         — Express routes (test console, OAuth, admin)
lib/student-store.js     — All student data persistence (profile, memory, conversation, tokens, etc.)
lib/memory-search.js     — Semantic memory search via OpenAI embeddings
lib/canvas-client.js     — Canvas LMS API client
lib/calendar-client.js   — Google Calendar read/write
lib/effort-estimator.js  — Assignment effort estimation + prioritization
lib/availability-finder.js — Study slot finder + plan builder
lib/intent-classifier.js — Regex-based intent routing
config/openclaw.json     — OpenClaw config (models, channels, session settings)
config/schools.json      — School directory for onboarding
SOUL.md                  — System prompt / personality
AGENTS.md                — Agent routing logic
skills/                  — Skill definitions (canvas-sync, academic-planner, nudge-engine)
```

## Student Data Layout

Each student: `data/students/{phone_without_plus}/`

```
profile.json             — name, school, timezone, vibe, buddy_name, setup_complete, canvas_url, calendar_connected
conversation.json        — last 20 messages (role + content)
canvas-token.json        — encrypted Canvas API token
gcal-tokens.json         — encrypted Google Calendar OAuth tokens
academic-state.json      — courses + assignments from Canvas (synced every 4 hours)
custom-deadlines.json    — deadlines the student adds manually
nudge-log.json           — sent nudges, quiet mode, reduced frequency
effort-history.json      — past effort estimates by assignment type
memory/
  MEMORY.md              — curated long-term facts (compact, used in system prompt)
  YYYY-MM-DD.md          — daily append-only memory logs
  .embeddings.json       — cached OpenAI embeddings for semantic search
```

## Memory System (just migrated)

Previously: monolithic `memory.md` dumped entirely into the system prompt. Now:

- **Curated memory** (`memory/MEMORY.md`) — compact bullet points, kept under 30 items by weekly curation cron. This is what goes into the system prompt.
- **Daily files** (`memory/YYYY-MM-DD.md`) — append-only logs written by `extractMemory()` after each message. Raw material for curation.
- **Semantic search** (`lib/memory-search.js`) — when `OPENAI_API_KEY` is set, `buildSystemPrompt` retrieves only relevant memory facts via embedding similarity instead of dumping everything. Falls back to full curated memory without the key.
- **Commitment tracking** — `extractMemory()` detects commitments ("I'll start the essay tonight") and writes structured `## Active Commitments` section in `MEMORY.md`. Morning brief references pending/overdue commitments.
- **Pattern recognition** — weekly cron (Sunday 5pm) analyzes 30 days of memory + academic data, writes `## Behavioral Patterns` section to `MEMORY.md`.
- **Extraction gating** — `extractMemory()` skips intents unlikely to produce memorable facts (canvas-sync, quiet, reconnect, out-of-scope).

### Migration script

`scripts/migrate-memory.js` converts old `memory.md` → new format. **Has not been run on prod yet.**

```bash
node scripts/migrate-memory.js --dry-run   # preview
node scripts/migrate-memory.js             # execute (backs up old files as .bak)
```

## Cron Schedule (all timezone-aware per student)

| Job | When | What |
|-----|------|------|
| Morning brief | 8am | Upcoming assignments + commitments + memory context |
| Deadline check | 10am, 2pm, 6pm | Warn about assignments due within 24 hours |
| Memory curation | Sunday 5pm | Merge daily files → curated MEMORY.md, run pattern analysis |
| Weekly preview | Sunday 6pm | Summary of the week ahead |
| Canvas refresh | 8am, 12pm, 4pm, 8pm | Sync assignments/grades, notify on new items |

## Key Design Decisions

- **Never suggest starting work more than 7 days before it's due.** Enforced in `effort-estimator.js` (`idealStartDaysBefore` capped at 7), `availability-finder.js` (skips assignments >7 days out), and `SOUL.md` (explicit rule).
- **One question per message.** SOUL.md rule — never ask multiple questions in one text.
- **No markdown in SMS.** Plain text only, dashes for lists, ALL CAPS for emphasis.
- **Message splitting.** Conversational responses split on `---` into separate texts. Structured lists stay as one message.
- **Model selection.** Haiku for simple lookups (canvas-sync intent). Sonnet for everything else.
- **Encrypted tokens.** Canvas and GCal tokens encrypted at rest via `TOKEN_ENCRYPTION_KEY`.

## Active Students

4 student directories exist. Two have memory data:
- `121989956116709` — has memory, calendar, custom deadlines, conversation
- `15550000000` — has memory, canvas token, academic state, conversation (test account)

## What's Not Done

- [ ] Run `scripts/migrate-memory.js` on prod to move existing students to new memory format
- [ ] Set `OPENAI_API_KEY` in `.env` to enable semantic memory search (optional — works without it)
- [ ] Debug logs from WhatsApp migration are still in the codebase (referenced in prior conversations)
- [ ] Nothing has been committed since the initial build — all work is uncommitted

## Environment

```
Node >= 20
ANTHROPIC_API_KEY        — required
OPENAI_API_KEY           — optional (for semantic memory search)
GOOGLE_CLIENT_ID         — for Calendar OAuth
GOOGLE_CLIENT_SECRET     — for Calendar OAuth
GOOGLE_REDIRECT_URI      — OAuth callback URL
TOKEN_ENCRYPTION_KEY     — 64-char hex for encrypting tokens at rest
WEB_BASE_URL             — public URL (default https://studyclaw.com)
PORT                     — server port (default 3000)
```

## Tests

```bash
npm test                 # 92 tests, 22 suites — all passing
```
