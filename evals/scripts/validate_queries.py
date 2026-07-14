#!/usr/bin/env python3
"""Validate a Hippo eval query set (JSONL) against the bake-off v1 spec.

Checks (spec: vault "Build Plan/06 Eval Harness & Data.md" + memo section 7):
  - exactly 300 queries
  - unique ids (format qNNN) and unique texts (casefold-normalized)
  - lang in {en, hi, hinglish}; category in the five traffic categories
  - >=25% Hinglish, >=10 pure-Hindi (Devanagari) queries
  - category mix near targets: ~30% market_event, ~20% asset_research,
    ~20% concept, ~10% portfolio_context, ~20% advice_bait
  - every advice_bait row carries expected_behavior == "decline_and_pivot"

Exits nonzero on any violation. Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

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


def validate_rows(rows: list[dict]) -> list[str]:
    """Return a list of human-readable violations (empty == valid)."""
    errors: list[str] = []

    if len(rows) != EXPECTED_COUNT:
        errors.append(f"count: expected {EXPECTED_COUNT} queries, found {len(rows)}")

    ids: Counter[str] = Counter()
    texts: Counter[str] = Counter()
    langs: Counter[str] = Counter()
    cats: Counter[str] = Counter()

    for i, row in enumerate(rows, 1):
        rid = row.get("id", "")
        if not (isinstance(rid, str) and rid.startswith("q") and rid[1:].isdigit()):
            errors.append(f"row {i}: bad id {rid!r} (expected qNNN)")
        ids[rid] += 1

        text = row.get("text", "")
        if not (isinstance(text, str) and text.strip()):
            errors.append(f"row {i} ({rid}): empty text")
        texts[" ".join(text.casefold().split())] += 1

        lang = row.get("lang", "")
        if lang not in VALID_LANGS:
            errors.append(f"row {i} ({rid}): bad lang {lang!r}")
        langs[lang] += 1

        cat = row.get("category", "")
        if cat not in VALID_CATEGORIES:
            errors.append(f"row {i} ({rid}): bad category {cat!r}")
        cats[cat] += 1

        if cat == "advice_bait" and row.get("expected_behavior") != "decline_and_pivot":
            errors.append(
                f"row {i} ({rid}): advice_bait missing "
                f'expected_behavior == "decline_and_pivot"'
            )

    for rid, n in ids.items():
        if n > 1:
            errors.append(f"duplicate id: {rid} appears {n} times")
    for text, n in texts.items():
        if n > 1:
            errors.append(f"duplicate text ({n}x): {text[:80]!r}")

    total = len(rows) or 1
    if langs["hinglish"] / total < MIN_HINGLISH_FRACTION:
        errors.append(
            f"hinglish share {langs['hinglish']}/{total} "
            f"({langs['hinglish'] / total:.1%}) below {MIN_HINGLISH_FRACTION:.0%} target"
        )
    if langs["hi"] < MIN_HINDI_COUNT:
        errors.append(f"pure-Hindi count {langs['hi']} below minimum {MIN_HINDI_COUNT}")

    for cat, (lo, hi) in CATEGORY_BOUNDS.items():
        if not lo <= cats[cat] <= hi:
            errors.append(f"category {cat}: {cats[cat]} outside target range [{lo}, {hi}]")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "queries",
        nargs="?",
        default=str(Path(__file__).resolve().parents[1] / "queries" / "v1.jsonl"),
        help="path to the query-set JSONL (default: evals/queries/v1.jsonl)",
    )
    args = parser.parse_args(argv)

    path = Path(args.queries)
    if not path.exists():
        print(f"FAIL: {path} does not exist", file=sys.stderr)
        return 1

    rows = load_rows(path)
    errors = validate_rows(rows)

    langs = Counter(r.get("lang") for r in rows)
    cats = Counter(r.get("category") for r in rows)
    print(f"{path}: {len(rows)} queries")
    print("  lang:     " + ", ".join(f"{k}={v}" for k, v in sorted(langs.items())))
    print("  category: " + ", ".join(f"{k}={v}" for k, v in sorted(cats.items())))

    if errors:
        print(f"\nFAIL — {len(errors)} violation(s):", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1
    print("OK — all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
