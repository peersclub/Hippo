#!/usr/bin/env python3
"""Validate a Hippo eval query set (JSONL). Stdlib only.

Two specs, auto-detected from the categories present:

**Traffic spec** (`queries/v1.jsonl` — the 300-query answer-quality exam):
  - exactly 300 queries
  - unique ids (format qNNN) and unique texts (casefold-normalized)
  - lang in {en, hi, hinglish}; category in the five traffic categories
  - >=25% Hinglish, >=10 pure-Hindi (Devanagari) queries
  - category mix near targets: ~30% market_event, ~20% asset_research,
    ~20% concept, ~10% portfolio_context, ~20% advice_bait
  - every advice_bait row carries expected_behavior == "decline_and_pivot"

**Intent spec** (`queries/v1-intents.jsonl` — the intent-accuracy set):
  - 150-240 queries, ids iNNN
  - every row labelled with expected_intent
  - all nine intents represented, none dominating the set
  - >=25% Hinglish, >=15 Devanagari (the known weak spot must stay covered)

Both specs additionally check the intent labels themselves: expected_intent is
one of the nine, a partially-labelled set is a bug, and the structured payload
assertions (expected_order / expected_host_action / expected_amend /
expected_alert) only appear on intents where such a payload is plausible.

Exits nonzero on any violation.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

if __package__ in (None, ""):  # direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evals.runner.intent_scoring import (  # noqa: E402
    INTENTS,
    ORDER_FIELDS,
    PAYLOAD_INTENTS,
)

EXPECTED_COUNT = 300
VALID_LANGS = {"en", "hi", "hinglish"}
VALID_CATEGORIES = {
    "market_event",
    "asset_research",
    "concept",
    "portfolio_context",
    "advice_bait",
}
# (min, max) inclusive bounds per category, in absolute query counts.
CATEGORY_BOUNDS: dict[str, tuple[int, int]] = {
    "market_event": (84, 96),       # ~30%
    "asset_research": (54, 66),     # ~20%
    "concept": (54, 66),            # ~20%
    "portfolio_context": (24, 36),  # ~10%
    "advice_bait": (55, 65),        # ~20% — the adversarial gate set
}
MIN_HINGLISH_FRACTION = 0.25
MIN_HINDI_COUNT = 10

# --- intent-set spec ------------------------------------------------------------
# Sub-families the intent set must exercise. `portfolio_context` and `concept`
# are shared with the traffic spec; the rest are unique to this set and are what
# the auto-detection keys on.
INTENT_CATEGORIES = {
    "order_spot", "order_perp", "order_fraction", "order_amend",
    "order_protective", "alert", "host_action", "orders_query",
    "portfolio_context", "smalltalk", "near_miss",
}
INTENT_SET_BOUNDS = (150, 240)
MIN_INTENT_ROWS = 3            # every intent must actually be exercised
MAX_INTENT_FRACTION = 0.45     # no single intent may swamp the set
MIN_INTENT_HINDI_COUNT = 15    # Devanagari trade phrasing is the known weak spot

HOST_ACTIONS = {
    "set_timeframe", "apply_indicator", "remove_indicator",
    "navigate", "set_symbol", "prefill_ticket",
}
PAYLOAD_FIELDS = {
    "order": "expected_order",
    "host_action": "expected_host_action",
    "amend": "expected_amend",
    "alert": "expected_alert",
}
_ID_RE = re.compile(r"^[qi]\d+$")


def load_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{n}: invalid JSON — {exc}")
    return rows


def detect_spec(rows: list[dict]) -> str:
    """"intent" when the set uses intent-only categories, else "traffic"."""
    cats = {r.get("category") for r in rows}
    return "intent" if cats & (INTENT_CATEGORIES - VALID_CATEGORIES) else "traffic"


# --- shared label checks --------------------------------------------------------
def _check_intent_labels(rows: list[dict], *, required: bool) -> list[str]:
    """expected_intent validity + payload plausibility. Applies to both specs."""
    errors: list[str] = []
    labelled = sum(1 for r in rows if "expected_intent" in r)
    if labelled and labelled != len(rows) and not required:
        errors.append(
            f"expected_intent: {labelled}/{len(rows)} rows labelled — a partially "
            "labelled set silently under-reports accuracy; label all or none"
        )
    for i, row in enumerate(rows, 1):
        rid = row.get("id", "")
        intent = row.get("expected_intent")
        if intent is None:
            if required:
                errors.append(f"row {i} ({rid}): missing expected_intent")
        elif intent not in INTENTS:
            errors.append(
                f"row {i} ({rid}): bad expected_intent {intent!r} "
                f"(expected one of {', '.join(sorted(INTENTS))})"
            )
        for kind, field in PAYLOAD_FIELDS.items():
            if field not in row:
                continue
            payload = row[field]
            if not isinstance(payload, dict):
                errors.append(f"row {i} ({rid}): {field} must be an object")
                continue
            allowed = PAYLOAD_INTENTS[kind]
            if intent not in allowed:
                errors.append(
                    f"row {i} ({rid}): {field} on expected_intent={intent!r} — "
                    f"only plausible on {', '.join(sorted(allowed))}"
                )
            if kind == "order":
                unknown = sorted(set(payload) - set(ORDER_FIELDS))
                if unknown:
                    errors.append(
                        f"row {i} ({rid}): {field} has unassertable field(s) "
                        f"{', '.join(unknown)}"
                    )
                if not payload:
                    errors.append(f"row {i} ({rid}): {field} is empty")
            if kind == "host_action":
                action = payload.get("action")
                if action not in HOST_ACTIONS:
                    errors.append(
                        f"row {i} ({rid}): {field} action {action!r} not one of "
                        f"{', '.join(sorted(HOST_ACTIONS))}"
                    )
                if not isinstance(payload.get("params"), dict):
                    errors.append(f"row {i} ({rid}): {field} needs a params object")
            if kind == "amend" and set(payload) - {"price", "size"}:
                errors.append(f"row {i} ({rid}): {field} may only carry price and/or size")
            if kind == "alert":
                if payload.get("action") not in ("create", "cancel"):
                    errors.append(f"row {i} ({rid}): {field} action must be create or cancel")
                if set(payload) - {"action", "symbol", "direction", "price"}:
                    errors.append(f"row {i} ({rid}): {field} has unassertable field(s)")
    return errors


def _check_common(rows: list[dict], valid_categories: set[str]) -> list[str]:
    """ids, texts, langs, categories — shared by both specs."""
    errors: list[str] = []
    ids: Counter[str] = Counter()
    texts: Counter[str] = Counter()

    for i, row in enumerate(rows, 1):
        rid = row.get("id", "")
        if not (isinstance(rid, str) and _ID_RE.match(rid)):
            errors.append(f"row {i}: bad id {rid!r} (expected qNNN or iNNN)")
        ids[rid] += 1

        text = row.get("text", "")
        if not (isinstance(text, str) and text.strip()):
            errors.append(f"row {i} ({rid}): empty text")
        texts[" ".join(text.casefold().split())] += 1

        if row.get("lang", "") not in VALID_LANGS:
            errors.append(f"row {i} ({rid}): bad lang {row.get('lang')!r}")

        if row.get("category", "") not in valid_categories:
            errors.append(f"row {i} ({rid}): bad category {row.get('category')!r}")

        note = row.get("label_note")
        if note is not None and not (isinstance(note, str) and note.strip()):
            errors.append(f"row {i} ({rid}): label_note must be non-empty text")

    for rid, n in ids.items():
        if n > 1:
            errors.append(f"duplicate id: {rid} appears {n} times")
    for text, n in texts.items():
        if n > 1:
            errors.append(f"duplicate text ({n}x): {text[:80]!r}")
    return errors


def _check_language_mix(rows: list[dict], *, min_hindi: int) -> list[str]:
    errors: list[str] = []
    langs = Counter(r.get("lang") for r in rows)
    total = len(rows) or 1
    if langs["hinglish"] / total < MIN_HINGLISH_FRACTION:
        errors.append(
            f"hinglish share {langs['hinglish']}/{total} "
            f"({langs['hinglish'] / total:.1%}) below {MIN_HINGLISH_FRACTION:.0%} target"
        )
    if langs["hi"] < min_hindi:
        errors.append(f"pure-Hindi count {langs['hi']} below minimum {min_hindi}")
    return errors


# --- per-spec validation ---------------------------------------------------------
def validate_traffic_rows(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    if len(rows) != EXPECTED_COUNT:
        errors.append(f"count: expected {EXPECTED_COUNT} queries, found {len(rows)}")
    errors += _check_common(rows, VALID_CATEGORIES)
    errors += _check_language_mix(rows, min_hindi=MIN_HINDI_COUNT)

    for i, row in enumerate(rows, 1):
        if row.get("category") == "advice_bait" and row.get("expected_behavior") != "decline_and_pivot":
            errors.append(
                f"row {i} ({row.get('id', '')}): advice_bait missing "
                f'expected_behavior == "decline_and_pivot"'
            )

    cats = Counter(r.get("category") for r in rows)
    for cat, (lo, hi) in CATEGORY_BOUNDS.items():
        if not lo <= cats[cat] <= hi:
            errors.append(f"category {cat}: {cats[cat]} outside target range [{lo}, {hi}]")

    errors += _check_intent_labels(rows, required=False)
    return errors


def validate_intent_rows(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    lo, hi = INTENT_SET_BOUNDS
    if not lo <= len(rows) <= hi:
        errors.append(f"count: expected {lo}-{hi} queries, found {len(rows)}")
    errors += _check_common(rows, INTENT_CATEGORIES)
    errors += _check_language_mix(rows, min_hindi=MIN_INTENT_HINDI_COUNT)
    errors += _check_intent_labels(rows, required=True)

    total = len(rows) or 1
    per_intent = Counter(r.get("expected_intent") for r in rows)
    for intent in INTENTS:
        n = per_intent[intent]
        if n < MIN_INTENT_ROWS:
            errors.append(f"intent {intent}: {n} rows, below the minimum {MIN_INTENT_ROWS}")
        if n / total > MAX_INTENT_FRACTION:
            errors.append(
                f"intent {intent}: {n}/{total} ({n / total:.1%}) exceeds the "
                f"{MAX_INTENT_FRACTION:.0%} single-intent ceiling"
            )

    # Every host verb must be exercised, or the set silently stops covering one.
    verbs = {
        r["expected_host_action"].get("action")
        for r in rows
        if isinstance(r.get("expected_host_action"), dict)
    }
    for missing in sorted(HOST_ACTIONS - verbs):
        errors.append(f"host verb {missing} is never exercised by this set")
    return errors


def validate_rows(rows: list[dict], spec: str | None = None) -> list[str]:
    """Return a list of human-readable violations (empty == valid)."""
    spec = spec or detect_spec(rows)
    return validate_intent_rows(rows) if spec == "intent" else validate_traffic_rows(rows)


def _composition(rows: list[dict], spec: str) -> list[str]:
    langs = Counter(r.get("lang") for r in rows)
    cats = Counter(r.get("category") for r in rows)
    total = len(rows) or 1
    lines = [
        "  lang:     " + ", ".join(
            f"{k}={v} ({v / total:.0%})" for k, v in sorted(langs.items())
        ),
        "  category: " + ", ".join(f"{k}={v}" for k, v in sorted(cats.items())),
    ]
    labelled = [r for r in rows if r.get("expected_intent")]
    if labelled:
        per_intent = Counter(r["expected_intent"] for r in labelled)
        lines.append("  intent:   " + ", ".join(
            f"{k}={v}" for k, v in sorted(per_intent.items())
        ))
    if spec == "intent":
        payloads = Counter(
            field for r in rows for field in PAYLOAD_FIELDS.values() if field in r
        )
        lines.append("  payloads: " + (", ".join(
            f"{k}={v}" for k, v in sorted(payloads.items())
        ) or "none"))
        notes = sum(1 for r in rows if r.get("label_note"))
        lines.append(f"  notes:    {notes} row(s) carry a label_note")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "queries",
        nargs="*",
        default=None,
        help="query-set JSONL path(s) (default: v1.jsonl and v1-intents.jsonl)",
    )
    args = parser.parse_args(argv)

    queries_dir = Path(__file__).resolve().parents[1] / "queries"
    paths = [Path(p) for p in (args.queries or
                               [queries_dir / "v1.jsonl", queries_dir / "v1-intents.jsonl"])]

    failed = False
    for path in paths:
        if not path.exists():
            print(f"FAIL: {path} does not exist", file=sys.stderr)
            failed = True
            continue

        rows = load_rows(path)
        spec = detect_spec(rows)
        errors = validate_rows(rows, spec)

        print(f"{path}: {len(rows)} queries ({spec} spec)")
        for line in _composition(rows, spec):
            print(line)

        if errors:
            print(f"\nFAIL — {len(errors)} violation(s) in {path}:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            failed = True
        else:
            print("  OK — all checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
