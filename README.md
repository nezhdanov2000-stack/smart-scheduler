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
                    Google Calendar API (POST / PATCH / DELETE) ─► Telegram confirmation
```

Everything runs on one Windows laptop: n8n installed with npm (its built-in SQLite database),
a Cloudflare quick tunnel for the Telegram webhook. No Docker, no Redis, no PostgreSQL.

## What is in the box

| Path | Purpose |
|---|---|
| `start.ps1` / `start.bat` | One-click start: tunnel → `.env` → first-run import → `n8n start` |
| `.env.example` | Template for your local secrets (`.env`) |
| `workflows/scheduling_pipeline.json` | The three-stage pipeline (imported into n8n automatically) |
| `workflows/baseline_single_model.json` | Single-model baseline workflow (kept inactive) |
| `workflows/src/*.js` | Source of every Code node (validator, retry logic, event lookup, confirmation flow) |
| `prompts/*.txt` | Stage 1–3 and baseline system prompts |
| `schema/calendar_command.schema.json` | JSON Schema the Stage 3 output is validated against |
| `dataset/telegram_scheduling_120.jsonl` | 120-message evaluation set with ground truth |
| `evaluation/evaluate.py` | Pipeline-vs-baseline evaluation: intent, entities, command validity, message flow, latency |
| `scripts/build_workflows.py` | Rebuilds the workflow JSON from `prompts/` + `workflows/src/` |
| `tests/test_code_nodes.js` | Offline smoke test of the Code-node logic |
| `docs/` | Capstone project documentation: Final Report (PDF) and Presentation slides (PPTX) |

## Install (Windows, once)

1. **Node.js 22 LTS** — <https://nodejs.org>. n8n requires a Node.js version between 20.19 and 24.x
   (inclusive); 22 LTS is the safe choice. Check with `node -v`.
2. **n8n** — in PowerShell: `npm install n8n -g`. Check with `n8n --version`.
3. **cloudflared** — `winget install Cloudflare.cloudflared`, or download `cloudflared-windows-amd64.exe`
   from Cloudflare, rename it to `cloudflared.exe` and put it in this folder. No Cloudflare account is needed.
4. **Keys** — copy `.env.example` to `.env` and fill in:
   - `N8N_ENCRYPTION_KEY`: 64 random hex characters (`openssl rand -hex 32`, or any password generator).
     Never change it later — it decrypts the stored credentials.
   - `OPENAI_API_KEY` (platform.openai.com) and `TELEGRAM_BOT_TOKEN` (@BotFather).
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: in Google Cloud enable the **Google Calendar API**,
     create an OAuth client of type *Web application* with redirect URI
     `http://localhost:5678/rest/oauth2-credential/callback`, and add your Gmail as a test user on the
     consent screen.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1     # or double-click start.bat
```

The script opens the tunnel, writes its URL into `.env`, on the first run imports the credentials into
n8n's encrypted vault and both workflows, then starts n8n in the same window. **Ctrl+C** stops both.
Run it again after every reboot — the tunnel URL changes and n8n re-registers the Telegram webhook on start.

First time only, in the browser:

1. Open <http://localhost:5678> and create the owner account (local, your laptop only).
2. **Credentials → Google Calendar OAuth2 → Sign in with Google** (accept the "unverified app" warning —
   it is your own app).
3. Optional: open the workflow *Smart Scheduling - Three-Stage LLM Pipeline* → **Prepare Input** and adjust
   `CONFIG` (timezone, calendar ID, `ownerChatId`, `confirmBefore`). The workflow is already active.
4. For group chats, disable the bot's privacy mode in @BotFather (`/setprivacy` → Disable).

Send the bot *"Let's meet tomorrow at 4pm with Anna to review the budget"* — the event appears in the
calendar and the bot replies with a confirmation.

All n8n data (SQLite database, logs) lives in `.n8n\` inside this folder; delete it for a clean reinstall
(you will have to create the owner account and sign in to Google again).

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
- **create / modify / cancel** — POST; for PATCH and DELETE the target event is located by title
  similarity and start-time proximity among upcoming events (*Find Events* → *Pick Event*).
- **Reliability** — every external call retries 4 × 5 s (≈20 s recovery); n8n keeps execution logs for
  14 days (Executions tab).
- **Privacy** — self-hosted; only the LLM call leaves the laptop; credentials live in n8n's encrypted vault;
  invitations are never e-mailed to placeholder attendees (`sendUpdates=none`).
- **Latency** — each execution's duration is visible in n8n's Executions tab; `evaluation/evaluate.py`
  reports mean LLM latency per message.

## Telegram Business (your own private chats)

With Telegram Premium you can let the bot read your private chats (Settings → Telegram Business →
Chatbots). For that, enable **Business Mode** for the bot in @BotFather (`/mybots` → bot → Bot Settings →
Business Mode) and set `ownerChatId` in `CONFIG` to your own chat id with the bot. Messages from those
chats arrive as `business_message`; the pipeline treats them like any other, but confirmations go to
your private chat with the bot, prefixed with who said what — the bot never writes to the other person.

**Ask before adding.** With `confirmBefore: 'business'` (default) an event found in one of those chats is
not written immediately: the bot sends you a card with the parsed event and ✅ Add / ❌ Skip buttons. The
parsed context is parked in the workflow's static data (inside n8n's SQLite database); the button press
comes back as a `callback_query`, the context is restored and the calendar operation runs (still with the
conflict check already done). `'all'` asks for every message, `'none'` never asks. Requires `ownerChatId`.

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

Prompts and Code-node scripts are the source of truth. After editing them:

```powershell
python scripts/build_workflows.py                    # regenerate workflows/*.json
npm i luxon; node tests/test_code_nodes.js           # offline test of the node logic
# stop n8n (Ctrl+C in its window), then re-import:
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Reimport
```

## Known limitations

English only · each message is processed in isolation (no conversation window) · no clarification
dialogue · no multi-user conflict resolution · the quick-tunnel URL changes on every start (use a named
Cloudflare tunnel or ngrok static domain for a permanent deployment and put it in `WEBHOOK_URL`).
