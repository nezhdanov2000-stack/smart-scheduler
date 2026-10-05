# Smart Scheduler — LLM-Driven Scheduling with n8n, Telegram and Google Calendar

Smart Scheduler is an automated conversational scheduling system that transforms unstructured
chat messages (e.g. from Telegram) into Google Calendar events using a decomposed three-stage
GPT-4o-mini pipeline orchestrated by n8n.

A Telegram message such as *"Let's meet tomorrow after lunch to go over the project timeline"*
becomes a Google Calendar event with no manual entry.

```
Telegram webhook ─► Stage 1  filter + temporal normalisation ──(not scheduling)──► discard
                    Stage 2  intent (create/modify/cancel) + entity extraction
                    Stage 3  Calendar API command synthesis ─► schema validation ─┐
                                        ▲──── prompt-adjusted retry on failure ◄──┘
                    Google Calendar API (POST / PATCH / DELETE) ─► Telegram confirmation ─► audit log
```

## What is in the box

| Path | Purpose |
|---|---|
| `docker-compose.yml`, `.env.example`, `start.ps1` | Self-hosted stack: n8n (main + worker, queue mode), Redis/BullMQ, PostgreSQL |
| `workflows/scheduling_pipeline.json` | The three-stage pipeline (import into n8n) |
| `workflows/baseline_single_model.json` | Single-model baseline workflow |
| `workflows/src/*.js` | Source of every Code node (validator, retry logic, event lookup, audit) |
| `prompts/*.txt` | Stage 1–3 and baseline system prompts |
| `schema/calendar_command.schema.json` | JSON Schema the Stage 3 output is validated against |
| `db/init.sql` | `scheduling_audit` table (audit trail) |
| `dataset/telegram_scheduling_120.jsonl` | 120-message evaluation set with ground truth |
| `evaluation/evaluate.py` | Pipeline-vs-baseline evaluation: intent, entities, command validity, message flow, latency |
| `scripts/build_workflows.py` | Rebuilds the workflow JSON from `prompts/` + `workflows/src/` |
| `tests/test_code_nodes.js` | Offline smoke test of the Code-node logic |

## Setup

Secrets live only in your local `.env` (git-ignored) and in n8n's encrypted vault. You need: a Telegram
bot token (@BotFather), an OpenAI API key and a Google Cloud OAuth client. Telegram only delivers
webhooks over HTTPS; the bundled Cloudflare tunnel takes care of that.

1. `cp .env.example .env` and fill it in: passwords, `N8N_ENCRYPTION_KEY` (`openssl rand -hex 32`),
   `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, and the Google OAuth client ID/secret.
   In Google Cloud: enable the **Google Calendar API**, create an OAuth client of type *Web application*
   with the redirect URI `http://localhost:5678/rest/oauth2-credential/callback` (Google allows plain
   http for localhost), and add yourself as a test user on the consent screen.
2. Windows: `powershell -ExecutionPolicy Bypass -File .\start.ps1` (Docker Desktop running).
   The script opens a Cloudflare quick tunnel (no account needed) for the Telegram webhook, starts the
   stack and, on the first run, imports the credentials into n8n's encrypted vault and both workflows.
   Run it again after every reboot: the quick-tunnel URL changes, and n8n re-registers the webhook on start.
3. Open <http://localhost:5678>, create the owner account, then **Credentials → Google Calendar OAuth2 →
   Sign in with Google**.
4. Open the workflow *Smart Scheduling - Three-Stage LLM Pipeline*, adjust `CONFIG` in **Prepare Input**
   (timezone, calendar ID, retries, allowed chats) and **activate** it. In group chats, disable the bot's
   privacy mode in @BotFather (`/setprivacy` → Disable) so it can read all messages.

For a permanent deployment replace the quick tunnel with a fixed HTTPS URL (named Cloudflare tunnel,
ngrok static domain or a reverse proxy) and set `WEBHOOK_URL` in `.env`.

Send the bot *"Let's meet tomorrow at 4pm with Anna to review the budget"* — the event should
appear in the calendar and the bot replies with a confirmation.

## Architecture and Key Features

- **Task decomposition** — three separate LLM nodes, each with one system prompt and one job; n8n
  `IF` nodes, not the model, decide the transitions. Temperature 0, JSON mode, zero-shot.
- **Early exit** — non-scheduling messages stop after Stage 1 (one cheap call, no reply in the chat).
- **Schema validation + automatic prompt-adjusted retry** — *Validate Command* rejects hallucinated
  fields, malformed datetimes, wrong HTTP method, end ≤ start, invalid attendee e-mails; the error list is
  appended to the Stage 3 prompt and the stage is re-run (up to `maxStage3Retries`).
- **No double-booking** — before a create or modify, *Find Conflicts* → *Detect Conflict* compares the
  requested slot with the events already in the calendar (all-day and "free" events don't block; the event
  being moved is ignored). On an overlap nothing is written: the bot replies with the conflicting event and
  the next free slot of the same length that day. `conflictPolicy: 'allow'` in `CONFIG` disables the check.
  This includes intelligent conflict detection and slot suggestion.
- **create / modify / cancel** — POST; for PATCH and DELETE the target event is located by title
  similarity and start-time proximity among upcoming events (*Find Events* → *Pick Event*).
- **Reliability** — every external call retries 4 × 5 s (≈20 s recovery); queue mode gives
  backpressure and at-least-once execution through Redis/BullMQ; add workers with
  `docker compose up -d --scale n8n-worker=3`.
- **Privacy** — self-hosted; only the LLM call leaves the host; raw message text is kept out of the audit
  table by default (`logMessageText: false`); executions are pruned after 14 days; invitations are never
  e-mailed to placeholder attendees (`sendUpdates=none`).
- **Latency** — `scheduling_audit.latency_ms` records webhook-receipt → calendar-confirmation per message:
  `SELECT status, count(*), round(avg(latency_ms)) FROM scheduling_audit GROUP BY 1;`

## Telegram Business (your own private chats)

With Telegram Premium you can let the bot read your private chats (Settings → Telegram Business →
Chatbots). For that, enable **Business Mode** for the bot in @BotFather (`/mybots` → bot → Bot Settings →
Business Mode) and set `ownerChatId` in `CONFIG` to your own chat id with the bot. Messages from those
chats arrive as `business_message`; the pipeline treats them like any other, but confirmations go to
your private chat with the bot, prefixed with who said what — the bot never writes to the other person.

**Ask before adding.** With `confirmBefore: 'business'` (default) an event found in one of those chats is
not written immediately: the bot sends you a card with the parsed event and ✅ Add / ❌ Skip buttons. The
parsed context is parked in `pending_actions`; the button press comes back as a `callback_query`, the
context is restored and the calendar operation runs (still with the conflict check already done). `'all'`
asks for every message, `'none'` never asks. Requires `ownerChatId`.

## Dataset

`dataset/telegram_scheduling_120.jsonl` contains 120 benchmark messages:
72 clear scheduling messages (60 %), 30 ambiguous / implicit-time messages (25 %) and 18 non-scheduling messages (15 %).
All names and entities are anonymized.

Each line: `id, category, text, reference_datetime, timezone, is_scheduling, intent, entities{event_title,
start_datetime, end_datetime, location, participants}, datetime_strict`. Regenerate with
`python dataset/generate_dataset.py` (deterministic).

## Evaluation

```bash
pip install -r evaluation/requirements.txt
python evaluation/evaluate.py --dry-run          # plumbing check, no API key needed
python evaluation/evaluate.py                    # pipeline + baseline (~500 GPT-4o-mini calls, a few cents)
```
Outputs `evaluation/results/summary.json` and per-message predictions for manual inspection.

## Development

Prompts and Code-node scripts are the source of truth; after editing them run
`python scripts/build_workflows.py`, then `update.bat` (Windows) re-imports the workflow into the running
n8n and re-activates it. Test the node logic offline with
`npm i luxon && node tests/test_code_nodes.js`.

## Known limitations

English only · each message is processed in isolation (no conversation window) · no clarification
dialogue · no multi-user conflict resolution.

Skeleton status: the workflows have been validated structurally and their logic tested offline, but
not yet executed on a live n8n instance (that needs the credentials above). Node `typeVersion`s target
current n8n 1.x; if an import warns about a node version, open the node once and save it.
