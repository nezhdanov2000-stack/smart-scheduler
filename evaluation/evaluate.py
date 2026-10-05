#!/usr/bin/env python3
"""Evaluation protocol for the Smart Scheduling pipeline outside n8n.

Runs the three-stage pipeline and the single-model baseline over the dataset with the SAME
prompts the n8n workflow uses (prompts/*.txt), GPT-4o-mini, temperature 0, zero-shot, and
reports intent accuracy, entity-extraction accuracy, command validity, message
flow and mean LLM latency.

    export OPENAI_API_KEY=...            # or put it in .env
    python evaluation/evaluate.py                     # both systems, all 120 messages
    python evaluation/evaluate.py --system pipeline --limit 10
    python evaluation/evaluate.py --dry-run           # no API calls: checks the plumbing only

Scoring protocol: intent = exact match of scheduling / non-scheduling; entities = ALL of
title, datetime and participants must match (no partial credit); command validity = automated
schema validation. Titles are free text, so "match" means token overlap >= 0.5 with the
reference title.
"""
import argparse
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = {p.stem: p.read_text(encoding="utf-8").strip() for p in (ROOT / "prompts").glob("*.txt")}
SCHEMA = json.loads((ROOT / "schema" / "calendar_command.schema.json").read_text(encoding="utf-8"))
COMMAND_VALIDATOR = Draft7Validator(SCHEMA)
EVENT_VALIDATOR = Draft7Validator({**SCHEMA["definitions"]["event"], "definitions": SCHEMA["definitions"],
                                   "required": ["summary", "start", "end"]})
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
STOP = {"the", "a", "an", "with", "and", "of", "for", "to", "on", "our", "meeting", "call", "session", "discussion"}


# ── LLM access ────────────────────────────────────────────────────────────────
class LLM:
    def __init__(self, model, dry_run):
        self.model, self.dry_run, self.client = model, dry_run, None
        if not dry_run:
            from openai import OpenAI
            self.client = OpenAI()

    def __call__(self, system, user):
        if self.dry_run:
            return "{}", 0.0
        t0 = time.perf_counter()
        for attempt in range(4):                       # mirrors the n8n node retry (4 x 5 s)
            try:
                r = self.client.chat.completions.create(
                    model=self.model, temperature=0, response_format={"type": "json_object"},
                    messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
                return r.choices[0].message.content, time.perf_counter() - t0
            except Exception as e:                     # noqa: BLE001
                if attempt == 3:
                    raise
                print(f"  transient error ({e.__class__.__name__}), retrying in 5 s", file=sys.stderr)
                time.sleep(5)


def parse(raw):
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except (TypeError, ValueError):
        return {}


def now_line(row):
    from datetime import datetime
    wd = WEEKDAYS[datetime.fromisoformat(row["reference_datetime"]).weekday()]
    return f"Current date/time: {row['reference_datetime']} ({wd}), timezone {row['timezone']}"


# ── systems under test ───────────────────────────────────────────────────────
def run_pipeline(llm, row, max_retries=2, placeholder_domain="example.com"):
    out = {"is_scheduling": False, "intent": None, "entities": None, "command": None,
           "command_valid": None, "stage3_attempts": 0, "latency_s": 0.0}
    raw, dt = llm(PROMPTS["stage1_filter"], f"{now_line(row)}\nMessage: {row['text']}")
    out["latency_s"] += dt
    s1 = parse(raw)
    if s1.get("is_scheduling") is not True:
        return out
    out["is_scheduling"] = True

    raw, dt = llm(PROMPTS["stage2_extract"],
                  f"{now_line(row)}\nNormalised message: {s1.get('normalised_message') or row['text']}\n"
                  f"Temporal expressions: {json.dumps(s1.get('temporal_expressions', []))}")
    out["latency_s"] += dt
    s2 = parse(raw)
    out["intent"], out["entities"] = s2.get("intent"), s2.get("entities") or {}

    user = (f"Timezone: {row['timezone']}\nPlaceholder e-mail format for unknown attendees: "
            f"firstname.lastname@{placeholder_domain}\n"
            f"Stage 2 output: {json.dumps({'intent': out['intent'], 'entities': out['entities']})}")
    feedback = ""
    for attempt in range(1, max_retries + 2):
        raw, dt = llm(PROMPTS["stage3_synthesise"], user + feedback)
        out["latency_s"] += dt
        out["stage3_attempts"] = attempt
        cmd = parse(raw)
        errors = [e.message for e in COMMAND_VALIDATOR.iter_errors(cmd)] if cmd else ["output is not parseable JSON"]
        out["command"], out["command_valid"] = cmd, not errors
        if not errors:
            break
        feedback = ("\n\nYour previous output was rejected by schema validation:\n- " + "\n- ".join(errors[:8]) +
                    f"\nPrevious output: {raw}\nFix these problems and output the corrected JSON object only.")
    return out


def run_baseline(llm, row):
    raw, dt = llm(PROMPTS["baseline_single_model"], f"{now_line(row)}\nMessage: {row['text']}")
    b = parse(raw)
    sched = b.get("is_scheduling") is True
    cmd = b.get("api_command")
    valid = None
    if sched:   # the baseline emits a bare Events body; DELETE/PATCH specs only need to be JSON objects
        if b.get("intent") == "create":
            valid = isinstance(cmd, dict) and not list(EVENT_VALIDATOR.iter_errors(cmd))
        else:
            valid = isinstance(cmd, dict) and bool(cmd)
    return {"is_scheduling": sched, "intent": b.get("intent"), "entities": b.get("entities") or {},
            "command": cmd, "command_valid": valid, "stage3_attempts": 1 if sched else 0, "latency_s": dt}


# ── scoring ──────────────────────────────────────────────────────────────────
def tokens(s):
    return {t for t in re.split(r"[^a-z0-9]+", str(s or "").lower()) if t and t not in STOP}


def title_match(pred, gold):
    p, g = tokens(pred), tokens(gold)
    return bool(g) and len(p & g) / len(g) >= 0.5


def people_match(pred, gold):
    norm = lambda xs: {str(x).strip().lower().split()[0] for x in (xs or []) if str(x).strip()}
    return norm(pred) == norm(gold)


def datetime_match(pred, gold, strict):
    pred = str(pred or "")[:19]
    return pred == gold if strict else pred[:10] == gold[:10]


def entities_correct(pred, row):
    gold = row["entities"]
    ent = pred.get("entities") or {}
    return (pred.get("intent") == row["intent"]
            and title_match(ent.get("event_title"), gold["event_title"])
            and datetime_match(ent.get("start_datetime"), gold["start_datetime"], row["datetime_strict"])
            and people_match(ent.get("participants"), gold["participants"]))


def summarise(name, rows, preds):
    n = len(rows)
    tp = sum(r["is_scheduling"] and p["is_scheduling"] for r, p in zip(rows, preds))
    fp = sum((not r["is_scheduling"]) and p["is_scheduling"] for r, p in zip(rows, preds))
    fn = sum(r["is_scheduling"] and not p["is_scheduling"] for r, p in zip(rows, preds))
    tn = n - tp - fp - fn
    passed = [(r, p) for r, p in zip(rows, preds) if p["is_scheduling"]]
    ent_ok = sum(r["is_scheduling"] and entities_correct(p, r) for r, p in passed)
    cmd_ok = sum(p["command_valid"] is True for _, p in passed)
    corrections = sum(1 for r, p in zip(rows, preds)
                      if r["is_scheduling"] != p["is_scheduling"]
                      or (p["is_scheduling"] and r["is_scheduling"] and not (entities_correct(p, r) and p["command_valid"])))
    lat = [p["latency_s"] for p in preds if p["is_scheduling"]]
    pct = lambda a, b: f"{100 * a / b:.1f}% ({a}/{b})" if b else "n/a"
    return {
        "system": name, "n": n,
        "intent_recognition": pct(tp + tn, n),
        "entity_extraction": pct(ent_ok, len(passed)),
        "command_validity": pct(cmd_ok, len(passed)),
        "needs_manual_correction": f"{corrections}/{n}",
        "message_flow": {"passed_sched": tp, "passed_non_sched": fp, "rejected_sched": fn, "rejected_non_sched": tn},
        "mean_llm_latency_s": round(statistics.mean(lat), 2) if lat else None,
        "stage3_retries": sum(max(0, p["stage3_attempts"] - 1) for p in preds),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "dataset" / "telegram_scheduling_120.jsonl"))
    ap.add_argument("--system", choices=["pipeline", "baseline", "both"], default="both")
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--dry-run", action="store_true", help="no API calls; validates dataset, prompts and scoring code")
    args = ap.parse_args()

    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY=") and line.split("=", 1)[1].strip():
                os.environ.setdefault("OPENAI_API_KEY", line.split("=", 1)[1].strip())
    if not args.dry_run and not os.environ.get("OPENAI_API_KEY"):
        sys.exit("OPENAI_API_KEY is not set (use --dry-run to test without it).")

    rows = [json.loads(l) for l in Path(args.dataset).read_text(encoding="utf-8").splitlines() if l.strip()][: args.limit]
    llm = LLM(args.model, args.dry_run)
    results_dir = ROOT / "evaluation" / "results"
    results_dir.mkdir(exist_ok=True)
    systems = {"pipeline": run_pipeline, "baseline": run_baseline}
    report = []
    for name in (systems if args.system == "both" else [args.system]):
        preds = []
        for i, row in enumerate(rows, 1):
            preds.append(systems[name](llm, row))
            print(f"\r{name}: {i}/{len(rows)}", end="", file=sys.stderr)
        print(file=sys.stderr)
        with open(results_dir / f"{name}_predictions.jsonl", "w", encoding="utf-8") as f:
            for r, p in zip(rows, preds):
                f.write(json.dumps({"id": r["id"], "text": r["text"], "gold": {k: r[k] for k in ("is_scheduling", "intent", "entities")},
                                    "pred": p, "entities_correct": bool(r["is_scheduling"] and p["is_scheduling"] and entities_correct(p, r))},
                                   ensure_ascii=False) + "\n")
        report.append(summarise(name, rows, preds))
    (results_dir / "summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if args.dry_run:
        print("\n(dry run: the numbers above are meaningless - no model was called)")


if __name__ == "__main__":
    main()
