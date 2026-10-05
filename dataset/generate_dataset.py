#!/usr/bin/env python3
"""Generates dataset/telegram_scheduling_120.jsonl

Synthetic 120-message evaluation benchmark for scheduling pipeline:
    72 clear scheduling (60%) · 30 ambiguous / implicit-time (25%) · 18 non-scheduling (15%)
    => 102 ground-truth scheduling messages, 18 non-scheduling.
All names are fictional. Deterministic: same output on every run.

Ground-truth conventions (same defaults as the Stage 1 prompt):
    reference "now" = 2025-06-15T10:00:00 (Sunday), Asia/Bangkok
    date without a time -> 09:00 · "morning" 09:00 · "after lunch" 13:00 · "afternoon" 15:00
    "evening" 18:00 · "tonight" 20:00 · no end time -> start + 60 min
    "datetime_strict": false -> only the DATE of start_datetime is scored
"""
import json
import random
from datetime import datetime, timedelta
from pathlib import Path

NOW = datetime(2025, 6, 15, 10, 0, 0)
TZ = "Asia/Bangkok"
rng = random.Random(85860)


def d(day, h=9, m=0, month=6):
    return datetime(2025, month, day, h, m)


# (expression, start) – explicit
EXPLICIT = [
    ("tomorrow at 4pm", d(16, 16)), ("tomorrow at 10:30", d(16, 10, 30)), ("today at 6pm", d(15, 18)),
    ("on Tuesday at 2pm", d(17, 14)), ("on Wednesday at 11am", d(18, 11)), ("on Thursday at 3:30pm", d(19, 15, 30)),
    ("on Friday at 10am", d(20, 10)), ("this Saturday at noon", d(21, 12)), ("on June 24 at 2:30pm", d(24, 14, 30)),
    ("on 25 June at 9:00", d(25, 9)), ("on the 27th at 5pm", d(27, 17)), ("next Friday at 1pm", d(20, 13)),
    ("on July 2 at 10am", d(2, 10, 0, 7)), ("tomorrow at 8:15am", d(16, 8, 15)), ("on Monday June 23 at 4pm", d(23, 16)),
    ("the day after tomorrow at 3pm", d(17, 15)),
]
# (expression, start, strict) – implicit / ambiguous
IMPLICIT = [
    ("tomorrow after lunch", d(16, 13), True), ("after lunch", d(15, 13), True), ("tomorrow morning", d(16, 9), True),
    ("Friday afternoon", d(20, 15), True), ("this evening", d(15, 18), True), ("tonight", d(15, 20), True),
    ("next Friday", d(20, 9), True), ("sometime next week", d(16, 9), False), ("early next week", d(16, 9), False),
    ("Wednesday evening", d(18, 18), True), ("first thing tomorrow", d(16, 9), True), ("end of day Thursday", d(19, 17), False),
    ("after our class tomorrow", d(16, 13), False), ("on the 26th", d(26, 9), True), ("Thursday after lunch", d(19, 13), True),
]
# (title, activity phrase, location or None)
TOPICS = [
    ("Budget Review", "review the budget", None), ("Project Timeline Review", "go over the project timeline", None),
    ("Sprint Planning", "do sprint planning", "Room 301"), ("Thesis Draft Discussion", "discuss the thesis draft", "the library"),
    ("Client Demo Rehearsal", "rehearse the client demo", None), ("Marketing Sync", "sync on marketing", "Zoom"),
    ("Database Migration Planning", "plan the database migration", None), ("Group Presentation Practice", "practice the group presentation", "Room B204"),
    ("Interview Debrief", "debrief the interviews", None), ("Quarterly Report Review", "review the quarterly report", "the 5th floor meeting room"),
    ("Design Review", "review the new designs", "Google Meet"), ("Onboarding Session", "run the onboarding session", None),
    ("Lab Report Discussion", "talk about the lab report", "the campus cafe"), ("Hiring Plan Discussion", "discuss the hiring plan", None),
    ("API Integration Kickoff", "kick off the API integration", None), ("Project Proposal Review", "review the project proposal", "Stamford campus"),
    ("Team Lunch", "have a team lunch", "Siam Paragon"), ("Coffee Catch-up", "grab coffee and catch up", "Starbucks Asok"),
    ("Security Audit Prep", "prepare for the security audit", None), ("Course Project Meeting", "work on the course project", "the co-working space"),
]
PEOPLE = ["Anna", "Ben", "Chai", "Dipa", "Elena", "Farid", "Grace", "Hiro", "Ivan", "Julia", "Kenji", "Lina", "Mark", "Nok", "Omar", "Ploy"]

CREATE = [
    "Let's meet {t} to {a}{w}{l}.", "Can we {a} {t}{w}{l}?", "Guys, meeting {t} to {a}{w}{l}.",
    "I'd like to {a} {t}{w}{l} - please block the time.", "{T} {t}{l}{w}, put it in the calendar please.",
    "Hey, are you free {t}? We need to {a}{w}{l}.", "Scheduling a call {t} to {a}{w}.",
    "Reminder to self: {a} {t}{l}{w}.", "ok so we {a} {t}{w}{l}, confirmed", "Please set up a meeting {t} to {a}{w}{l}.",
]
MODIFY = [
    "Can we move the {T} to {n}?", "Change of plans - {T} is now {t}.", "Need to reschedule the {T}, let's do {t} instead.",
    "Please push the {T} to {n}{w}.", "Sorry, something came up. Let's shift {T} to {n}.",
]
CANCEL = [
    "Please cancel the {T} {t}.", "The {T} {t} is off, sorry everyone.", "Let's cancel {T} {t}, the client pulled out.",
    "I can't make it, please remove the {T} {t} from the calendar.", "{T} {t} is cancelled{w}.",
]
NON_SCHEDULING = [
    "Thanks for the meeting yesterday, it was really useful!", "Did anyone see the match last night?", "lol that meme is gold",
    "I woke up at 6am today and I'm already exhausted.", "The report from last Friday is in the shared drive.",
    "Happy birthday Nok!! 🎉", "Can someone send me the slides from the lecture?", "The wifi in the library is down again.",
    "We should meet up sometime, it's been ages!", "How was the meeting with the client last week?",
    "I'm usually free on Tuesdays but it depends.", "Our flight landed at 3pm yesterday, all good.", "ok", "Good morning everyone ☀️",
    "The deadline was moved twice already last semester, remember?", "Who's got the charger for the projector?",
    "Tomorrow is going to be so hot, 38 degrees they say.", "That 9am lecture today was brutal.",
]


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S") if dt else None


def people_phrase(names):
    if not names:
        return ""
    return " with " + (names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1])


def loc_phrase(loc):
    if not loc:
        return ""
    return (" on " if loc in ("Zoom", "Google Meet") else " at " if loc[0].isupper() else " in ") + loc


def make(category, intent, template, topic, texpr, start, strict=True):
    title, activity, location = topic
    names = rng.sample(PEOPLE, rng.choice([0, 1, 1, 2, 2, 3]))
    if intent != "create":
        location = None
        if "{w}" not in template:
            names = []
    if "{l}" not in template:
        location = None
    text = template.format(n=texpr[3:] if texpr.startswith("on ") else texpr, t=texpr, a=activity, T=title, w=people_phrase(names), l=loc_phrase(location))
    text = text[0].upper() + text[1:] if not text.startswith("ok so") else text
    return {
        "category": category, "text": text, "reference_datetime": iso(NOW), "timezone": TZ,
        "is_scheduling": True, "intent": intent,
        "entities": {"event_title": title, "start_datetime": iso(start), "end_datetime": iso(start + timedelta(minutes=60)),
                     "location": location, "participants": names},
        "datetime_strict": strict,
    }


def main():
    rows = []
    plan = [("clear", "create", CREATE, 56), ("clear", "modify", MODIFY, 8), ("clear", "cancel", CANCEL, 8),
            ("ambiguous", "create", CREATE, 24), ("ambiguous", "modify", MODIFY, 3), ("ambiguous", "cancel", CANCEL, 3)]
    for category, intent, templates, n in plan:
        seen = set()
        while len([r for r in rows if r["category"] == category and r["intent"] == intent]) < n:
            topic = rng.choice(TOPICS)
            if category == "clear":
                texpr, start = rng.choice(EXPLICIT); strict = True
            else:
                texpr, start, strict = rng.choice(IMPLICIT)
            key = (topic[0], texpr)
            if key in seen:
                continue
            seen.add(key)
            rows.append(make(category, intent, rng.choice(templates), topic, texpr, start, strict))
    for text in NON_SCHEDULING:
        rows.append({"category": "non_scheduling", "text": text, "reference_datetime": iso(NOW), "timezone": TZ,
                     "is_scheduling": False, "intent": None, "entities": None, "datetime_strict": True})
    rng.shuffle(rows)
    rows = [{"id": i + 1, **r} for i, r in enumerate(rows)]
    assert len(rows) == 120 and sum(r["is_scheduling"] for r in rows) == 102
    out = Path(__file__).with_name("telegram_scheduling_120.jsonl")
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    print(f"wrote {out.name}: {len(rows)} messages")


if __name__ == "__main__":
    main()
