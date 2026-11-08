#!/usr/bin/env python3
"""Builds the importable n8n workflows from prompts/*.txt and workflows/src/*.js.

Single source of truth: edit a prompt or a Code-node script, then run
    python scripts/build_workflows.py
and re-import workflows/*.json into n8n.
"""
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "workflows" / "src"
NS = uuid.UUID("6f1d1c5e-85a8-4a57-9a62-3c3a4f2d8b10")

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
CAL = "https://www.googleapis.com/calendar/v3/calendars/"
CRED = {
    "telegramApi": {"id": "schedTelegram0001", "name": "Telegram Bot"},
    "openAiApi": {"id": "schedOpenAi000001", "name": "OpenAI"},
    "googleCalendarOAuth2Api": {"id": "schedGoogleCal001", "name": "Google Calendar OAuth2"},
    "postgres": {"id": "schedPostgres0001", "name": "Audit Postgres"},
}


def nid(name):
    return str(uuid.uuid5(NS, name))


def prompt(name):
    return json.dumps((ROOT / "prompts" / name).read_text(encoding="utf-8").strip(), ensure_ascii=False)


def js(name, **subs):
    code = (SRC / name).read_text(encoding="utf-8")
    for key, value in subs.items():
        code = code.replace(f"__{key}__", value)
    assert "__STAGE" not in code and "__BASELINE" not in code, name
    return code


def node(name, type_, version, pos, params, creds=None, **extra):
    n = {"parameters": params, "id": nid(name), "name": name, "type": type_,
         "typeVersion": version, "position": list(pos)}
    if creds:
        n["credentials"] = {c: CRED[c] for c in creds}
    n.update(extra)
    return n


def code(name, pos, source):
    return node(name, "n8n-nodes-base.code", 2, pos, {"jsCode": source})


def llm(name, pos):
    """One discrete LLM stage: GPT-4o-mini, temperature 0, JSON mode. The request body is
    prepared by the preceding Code node; the key comes from the credential vault."""
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": "POST", "url": OPENAI_URL,
        "authentication": "predefinedCredentialType", "nodeCredentialType": "openAiApi",
        "sendBody": True, "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.request) }}",
        "options": {"timeout": 30000},
    }, ["openAiApi"], retryOnFail=True, maxTries=4, waitBetweenTries=5000)


def calendar(name, pos, method, url_expr, body_expr=None, query=None):
    params = {
        "method": method, "url": url_expr,
        "authentication": "predefinedCredentialType", "nodeCredentialType": "googleCalendarOAuth2Api",
        "options": {"timeout": 30000},
    }
    if query:
        params["sendQuery"] = True
        params["queryParameters"] = {"parameters": [{"name": k, "value": v} for k, v in query.items()]}
    if body_expr:
        params.update({"sendBody": True, "specifyBody": "json", "jsonBody": body_expr})
    # per-node retry: 4 tries x 5 s  ->  transient failures recover within ~20 s (Table IV)
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, params, ["googleCalendarOAuth2Api"],
                retryOnFail=True, maxTries=4, waitBetweenTries=5000, onError="continueRegularOutput")


def if_true(name, pos, expr):
    return node(name, "n8n-nodes-base.if", 2.2, pos, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": nid(name + "/c"), "leftValue": expr, "rightValue": "",
                            "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            "combinator": "and"},
        "options": {}})


def sticky(name, pos, size, text, color=None):
    p = {"content": text, "width": size[0], "height": size[1]}
    if color:
        p["color"] = color
    return node(name, "n8n-nodes-base.stickyNote", 1, pos, p)


def connect(conns, src, dst, output=0):
    outs = conns.setdefault(src, {"main": []})["main"]
    while len(outs) <= output:
        outs.append([])
    outs[output].append({"node": dst, "type": "main", "index": 0})


def workflow(name, nodes, conns):
    return {"id": "sched" + nid(name).replace("-", "")[:11], "name": name, "nodes": nodes, "connections": conns, "active": False,
            "settings": {"executionOrder": "v1", "saveManualExecutions": True},
            "pinData": {}, "tags": []}


EVENTS_URL = "={{ '" + CAL + "' + encodeURIComponent($json.config.calendarId) + '/events' }}"
EVENT_URL = "={{ '" + CAL + "' + encodeURIComponent($json.config.calendarId) + '/events/' + $json.lookup.event_id }}"


def build_pipeline():
    y = 300
    nodes = [
        sticky("Note: Ingestion", (-60, 100), (420, 380),
               "## Ingestion\nPersistent HTTPS webhook registered with the Telegram Bot API. "
               "In queue mode the execution is pushed to Redis/BullMQ and picked up by a worker.\n\n"
               "**Edit `CONFIG` in _Prepare Input_** (timezone, calendar, retries)."),
        sticky("Note: Stage 1", (400, 100), (640, 380),
               "## Stage 1 · Context filtering & temporal normalisation\nBinary scheduling-intent detection; "
               "\"after lunch\" → 13:00. Non-scheduling messages exit here.", 4),
        sticky("Note: Stage 2", (1080, 100), (640, 380),
               "## Stage 2 · Intent classification & entity extraction\ncreate / modify / cancel + title, "
               "datetime, participants, location. 60-minute default duration.", 5),
        sticky("Note: Stage 3", (1760, 100), (900, 560),
               "## Stage 3 · API command synthesis & validation\nJSON for the Calendar Events API v3, schema-validated; "
               "validation errors are fed back to the model for an automatic prompt-adjusted retry.", 6),
        sticky("Note: Calendar", (2700, -120), (1120, 780),
               "## Google Calendar API\nPOST (create) · PATCH (modify) · DELETE (cancel). "
               "Each call retries 4 × 5 s on transient failures.", 3),
        sticky("Note: Output", (3860, 100), (900, 560),
               "## Confirmation & audit trail\nTelegram reply + one row in `scheduling_audit` (PostgreSQL)."),

        node("Telegram Trigger", "n8n-nodes-base.telegramTrigger", 1.1, (0, y),
             {"updates": ["message"], "additionalFields": {}}, ["telegramApi"], webhookId=nid("telegram-webhook")),
        code("Prepare Input", (220, y), js("prepare_input.js", STAGE1_PROMPT=prompt("stage1_filter.txt"))),

        llm("Stage 1 LLM", (460, y)),
        code("Parse Stage 1", (680, y), js("parse_stage1.js", STAGE2_PROMPT=prompt("stage2_extract.txt"))),
        if_true("Scheduling?", (900, y), "={{ $json.stage1.is_scheduling }}"),

        llm("Stage 2 LLM", (1140, y)),
        code("Parse Stage 2", (1360, y), js("parse_stage2.js")),
        if_true("Entities OK?", (1580, y), "={{ $json.stage2.ok }}"),

        code("Build Stage 3 Request", (1820, y), js("build_stage3.js", STAGE3_PROMPT=prompt("stage3_synthesise.txt"))),
        llm("Stage 3 LLM", (2040, y)),
        code("Validate Command", (2260, y), js("validate_command.js")),
        if_true("Valid?", (2480, y), "={{ $json.stage3.valid }}"),
        if_true("Retry?", (2480, y + 220), "={{ $json.stage3.can_retry }}"),

        if_true("Create?", (2760, y), "={{ $json.stage3.command.method === 'POST' }}"),
        calendar("Create Event", (3400, y - 240), "POST", EVENTS_URL,
                 "={{ JSON.stringify($json.stage3.command.body) }}", {"sendUpdates": "none"}),
        calendar("Find Events", (2980, y + 100), "GET", EVENTS_URL, None, {
            "timeMin": "={{ $now.minus({ days: 1 }).toUTC().toISO() }}",
            "timeMax": "={{ $now.plus({ days: 90 }).toUTC().toISO() }}",
            "timeZone": "={{ $json.config.timezone }}",
            "singleEvents": "true", "orderBy": "startTime", "maxResults": "250"}),
        code("Pick Event", (3180, y + 100), js("pick_event.js")),
        if_true("Found?", (3380, y + 100), "={{ $json.lookup.found }}"),
        if_true("Cancel?", (3580, y), "={{ $json.stage3.command.method === 'DELETE' }}"),
        calendar("Delete Event", (3800, y - 100), "DELETE", EVENT_URL, None, {"sendUpdates": "none"}),
        calendar("Patch Event", (3800, y + 80), "PATCH", EVENT_URL,
                 "={{ JSON.stringify($json.stage3.command.body) }}", {"sendUpdates": "none"}),

        code("Finalize", (3920, y), js("finalize.js")),
        if_true("Has Reply?", (4120, y), "={{ $json.has_reply }}"),
        node("Send Confirmation", "n8n-nodes-base.telegram", 1.2, (4320, y - 80), {
            "resource": "message", "operation": "sendMessage",
            "chatId": "={{ $json.chat_id }}", "text": "={{ $json.reply }}",
            "additionalFields": {"appendAttribution": False,
                                 "reply_to_message_id": "={{ Number($json.message_id) }}"},
        }, ["telegramApi"], retryOnFail=True, maxTries=3, waitBetweenTries=3000, onError="continueRegularOutput"),
        node("Audit Log", "n8n-nodes-base.postgres", 2.5, (4540, y), {
            "operation": "executeQuery",
            "query": "INSERT INTO scheduling_audit (chat_id, message_id, status, intent, latency_ms, stage3_attempts, payload)\n"
                     "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb);",
            "options": {"queryReplacement":
                        "={{ [ $('Finalize').first().json.chat_id, $('Finalize').first().json.message_id, "
                        "$('Finalize').first().json.status, $('Finalize').first().json.intent, "
                        "$('Finalize').first().json.latency_ms, $('Finalize').first().json.stage3_attempts, "
                        "JSON.stringify($('Finalize').first().json.payload) ] }}"},
        }, ["postgres"], onError="continueRegularOutput"),
    ]
    c = {}
    for a, b in [("Telegram Trigger", "Prepare Input"), ("Prepare Input", "Stage 1 LLM"),
                 ("Stage 1 LLM", "Parse Stage 1"), ("Parse Stage 1", "Scheduling?"),
                 ("Stage 2 LLM", "Parse Stage 2"), ("Parse Stage 2", "Entities OK?"),
                 ("Build Stage 3 Request", "Stage 3 LLM"), ("Stage 3 LLM", "Validate Command"),
                 ("Validate Command", "Valid?"), ("Find Events", "Pick Event"), ("Pick Event", "Found?"),
                 ("Create Event", "Finalize"), ("Delete Event", "Finalize"), ("Patch Event", "Finalize"),
                 ("Finalize", "Has Reply?"), ("Send Confirmation", "Audit Log")]:
        connect(c, a, b)
    for src, yes, no in [("Scheduling?", "Stage 2 LLM", "Finalize"),
                         ("Entities OK?", "Build Stage 3 Request", "Finalize"),
                         ("Valid?", "Create?", "Retry?"),
                         ("Retry?", "Build Stage 3 Request", "Finalize"),
                         ("Create?", "Create Event", "Find Events"),
                         ("Found?", "Cancel?", "Finalize"),
                         ("Cancel?", "Delete Event", "Patch Event"),
                         ("Has Reply?", "Send Confirmation", "Audit Log")]:
        connect(c, src, yes, 0)
        connect(c, src, no, 1)
    return workflow("Smart Scheduling - Three-Stage LLM Pipeline", nodes, c)


def build_baseline():
    y = 300
    nodes = [
        sticky("Note: Baseline", (-60, 60), (1500, 440),
               "## Single-model baseline (paper, Table V)\nOne GPT-4o-mini call does filtering, extraction and command "
               "synthesis at once. For comparison only - it handles `create` and has no retry. "
               "Keep it **inactive** while the three-stage pipeline is active: a Telegram bot can only have one webhook."),
        node("Telegram Trigger", "n8n-nodes-base.telegramTrigger", 1.1, (0, y),
             {"updates": ["message"], "additionalFields": {}}, ["telegramApi"], webhookId=nid("telegram-webhook-baseline")),
        code("Prepare Input", (220, y), js("baseline_prepare.js", BASELINE_PROMPT=prompt("baseline_single_model.txt"))),
        llm("Single LLM", (440, y)),
        code("Parse Output", (660, y), js("baseline_parse.js")),
        if_true("Create?", (880, y), "={{ $json.ok }}"),
        calendar("Create Event", (1100, y - 80), "POST", EVENTS_URL,
                 "={{ JSON.stringify($json.api_command) }}", {"sendUpdates": "none"}),
    ]
    c = {}
    for a, b in [("Telegram Trigger", "Prepare Input"), ("Prepare Input", "Single LLM"),
                 ("Single LLM", "Parse Output"), ("Parse Output", "Create?")]:
        connect(c, a, b)
    connect(c, "Create?", "Create Event", 0)
    return workflow("Smart Scheduling - Single-Model Baseline", nodes, c)


if __name__ == "__main__":
    for fname, wf in [("scheduling_pipeline.json", build_pipeline()), ("baseline_single_model.json", build_baseline())]:
        path = ROOT / "workflows" / fname
        path.write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)}  ({len(wf['nodes'])} nodes)")
