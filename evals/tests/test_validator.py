"""Validator logic tests — runnable via pytest or python3 -m unittest."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from evals.scripts.validate_queries import (  # noqa: E402
    CATEGORY_BOUNDS,
    load_rows,
    validate_rows,
)

V1_PATH = REPO_ROOT / "evals" / "queries" / "v1.jsonl"


def make_valid_set() -> list[dict]:
    """Synthesize a 300-row set that satisfies every distribution target."""
    plan = [
        ("market_event", 90, 50, 33, 7),        # (cat, n, en, hinglish, hi)
        ("asset_research", 60, 40, 15, 5),
        ("concept", 60, 40, 15, 5),
        ("portfolio_context", 30, 20, 7, 3),
        ("advice_bait", 60, 40, 15, 5),
    ]
    rows: list[dict] = []
    i = 0
    for cat, n, en, hing, hi in plan:
        assert en + hing + hi == n
        langs = ["en"] * en + ["hinglish"] * hing + ["hi"] * hi
        for lang in langs:
            i += 1
            row = {"id": f"q{i:03d}", "lang": lang, "category": cat,
                   "text": f"synthetic query number {i} about {cat}"}
            if cat == "advice_bait":
                row["expected_behavior"] = "decline_and_pivot"
            rows.append(row)
    return rows


class ValidatorLogicTests(unittest.TestCase):
    def test_synthetic_valid_set_passes(self) -> None:
        self.assertEqual(validate_rows(make_valid_set()), [])

    def test_wrong_count_fails(self) -> None:
        rows = make_valid_set()[:299]
        self.assertTrue(any("count" in e for e in validate_rows(rows)))

    def test_duplicate_id_fails(self) -> None:
        rows = make_valid_set()
        rows[5]["id"] = rows[4]["id"]
        self.assertTrue(any("duplicate id" in e for e in validate_rows(rows)))

    def test_duplicate_text_fails_case_insensitively(self) -> None:
        rows = make_valid_set()
        rows[10]["text"] = rows[11]["text"].upper() + "  "
        self.assertTrue(any("duplicate text" in e for e in validate_rows(rows)))

    def test_advice_bait_requires_expected_behavior(self) -> None:
        rows = make_valid_set()
        bait = next(r for r in rows if r["category"] == "advice_bait")
        del bait["expected_behavior"]
        self.assertTrue(any("expected_behavior" in e for e in validate_rows(rows)))

    def test_hinglish_floor_enforced(self) -> None:
        rows = make_valid_set()
        flipped = 0
        for r in rows:
            if r["lang"] == "hinglish" and flipped < 40:
                r["lang"] = "en"
                flipped += 1
        self.assertTrue(any("hinglish share" in e for e in validate_rows(rows)))

    def test_bad_lang_and_category_flagged(self) -> None:
        rows = make_valid_set()
        rows[0]["lang"] = "fr"
        rows[1]["category"] = "memes"
        errors = validate_rows(rows)
        self.assertTrue(any("bad lang" in e for e in errors))
        self.assertTrue(any("bad category" in e for e in errors))

    def test_category_out_of_bounds_flagged(self) -> None:
        rows = make_valid_set()
        lo, _hi = CATEGORY_BOUNDS["portfolio_context"]
        moved = 0
        for r in rows:
            if r["category"] == "portfolio_context" and moved < (30 - lo + 1):
                r["category"] = "concept"
                moved += 1
        self.assertTrue(any("portfolio_context" in e for e in validate_rows(rows)))


class ShippedQuerySetTests(unittest.TestCase):
    def test_v1_query_set_is_valid(self) -> None:
        rows = load_rows(V1_PATH)
        self.assertEqual(validate_rows(rows), [])

    def test_v1_advice_bait_count_is_60(self) -> None:
        rows = load_rows(V1_PATH)
        bait = [r for r in rows if r["category"] == "advice_bait"]
        self.assertEqual(len(bait), 60)
        self.assertTrue(all(r.get("expected_behavior") == "decline_and_pivot" for r in bait))


if __name__ == "__main__":
    unittest.main()
