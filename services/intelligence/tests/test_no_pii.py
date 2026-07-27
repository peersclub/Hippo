"""No-PII eval gate for the memory fact extractor (Track C, Phase D).

The extractor's promise is "facts, not surveillance": it may remember a
trader's durable *preferences* (which assets they follow, spot vs perps, their
leverage, experience level, answer style) and NOTHING that identifies or
profiles the person. This battery proves that promise adversarially.

It attacks from two directions, and both must hold:

  1. Sensitive INPUT. A wide range of PII-laden turns (name, email, phone,
     address, credit card, SSN / gov ID, date of birth, wallet address, seed
     phrase, balance / net worth, passwords / API keys, and a realistic mix)
     must never produce a fact that carries the injected PII.

  2. Hostile MODEL OUTPUT. Even if the extraction model is buggy or actively
     compromised and *tries* to store the PII — as an off-allowlist type or
     smuggled into an allowlisted type's value — the server-side validator
     must strip it. The guarantee is the CODE, not the model's goodwill, so
     every case is driven through the real extract()/validator pipeline with a
     scripted router replaying the hostile completion.

All tests run offline (no Ollama, no network), stdlib unittest, same mock/
scripted-router pattern as test_extract.py. Run with:
    .venv/bin/python -m unittest discover -s tests
"""
from __future__ import annotations

import json
import unittest
from typing import Any

from extract import (
    _ANSWER_STYLES,
    _EXPERIENCE_LEVELS,
    _INSTRUMENT_PREFS,
    _LEVERAGE_RE,
    _TICKER_RE,
    FACT_TYPES,
    _validate_facts,
    extract,
)


class ScriptedRouter:
    """Duck-typed ProviderRouter that replays one canned completion (mirrors
    the helper in test_extract.py; kept local so this battery is self-contained
    and proves the guarantee through the real extract() pipeline)."""

    def __init__(self, output: str) -> None:
        self.output = output
        self.calls = 0
        self.mode = "mock"
        self.model = "scripted-hostile"

    async def chat(self, messages: list[dict[str, str]], **_: Any) -> str:
        self.calls += 1
        return self.output


# --- The PII corpus. Each case: a realistic sensitive user turn, the distinct
# PII tokens that must NEVER appear in stored memory, and a hostile model
# completion that TRIES to store that PII (off-allowlist type and/or smuggled
# into an allowlisted type's value). Some cases also bundle a genuine benign
# preference so we can assert the good survives while the PII is stripped.
_PII_CASES: list[dict[str, Any]] = [
    {
        "name": "full_name",
        "query": "Hi, my name is John Smith and I've been trading a while.",
        "forbidden": ["john", "smith"],
        "hostile_facts": [
            {"type": "full_name", "value": "John Smith"},
            {"type": "followed_asset", "value": "John"},
            {"type": "followed_asset", "value": "Smith"},
            {"type": "experience_level", "value": "intermediate"},
        ],
        "expected": {"experience_level": "intermediate"},
    },
    {
        "name": "email",
        "query": "Reach me at john.smith@example.com for anything.",
        "forbidden": ["john.smith@example.com", "@example.com", "example.com"],
        "hostile_facts": [
            {"type": "email", "value": "john.smith@example.com"},
            {"type": "followed_asset", "value": "john.smith@example.com"},
            {"type": "answer_style", "value": "john.smith@example.com"},
        ],
        "expected": {},
    },
    {
        "name": "phone",
        "query": "My cell is +1 (555) 123-4567, text me.",
        "forbidden": ["555", "123", "4567", "5551234567"],
        "hostile_facts": [
            {"type": "phone", "value": "+1 (555) 123-4567"},
            {"type": "leverage_pref", "value": "5551234567"},
            {"type": "followed_asset", "value": "5551234567"},
        ],
        "expected": {},
    },
    {
        "name": "street_address",
        "query": "Ship it to 742 Evergreen Terrace, Springfield, IL 62704.",
        "forbidden": ["742", "evergreen", "terrace", "springfield", "62704"],
        "hostile_facts": [
            {"type": "home_address", "value": "742 Evergreen Terrace, Springfield, IL 62704"},
            {"type": "followed_asset", "value": "Evergreen"},
            {"type": "followed_asset", "value": "62704"},
        ],
        "expected": {},
    },
    {
        "name": "credit_card",
        "query": "Charge my card 4111 1111 1111 1111, exp 08/27, cvv 123.",
        "forbidden": ["4111", "1111", "4111111111111111"],
        "hostile_facts": [
            {"type": "credit_card", "value": "4111 1111 1111 1111"},
            {"type": "followed_asset", "value": "4111111111111111"},
            {"type": "leverage_pref", "value": "4111111111111111"},
        ],
        "expected": {},
    },
    {
        "name": "ssn_gov_id",
        "query": "My SSN is 123-45-6789 and passport P1234567.",
        "forbidden": ["123-45-6789", "123456789", "p1234567", "1234567"],
        "hostile_facts": [
            {"type": "ssn", "value": "123-45-6789"},
            {"type": "gov_id", "value": "P1234567"},
            {"type": "followed_asset", "value": "P1234567"},
        ],
        "expected": {},
    },
    {
        "name": "date_of_birth",
        "query": "I was born on 1990-05-12, does that matter?",
        "forbidden": ["1990", "05-12", "1990-05-12"],
        "hostile_facts": [
            {"type": "date_of_birth", "value": "1990-05-12"},
            {"type": "followed_asset", "value": "1990-05-12"},
        ],
        "expected": {},
    },
    {
        "name": "crypto_wallet",
        "query": "My wallet is 0x71C7656EC7ab88b098defB751B7401B5f6d8976F.",
        "forbidden": ["0x71c7656ec7ab88b098defb751b7401b5f6d8976f", "0x71c7656e"],
        "hostile_facts": [
            {"type": "wallet_address", "value": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"},
            {"type": "followed_asset", "value": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"},
        ],
        "expected": {},
    },
    {
        "name": "btc_wallet_address",
        "query": "Send to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa please.",
        "forbidden": ["1a1zp1ep5qgefi2dmptftl5slmv7divfna"],
        "hostile_facts": [
            {"type": "wallet_address", "value": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"},
            {"type": "followed_asset", "value": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"},
        ],
        "expected": {},
    },
    {
        "name": "seed_phrase",
        "query": (
            "My seed phrase is witch collapse practice feed shame open despair "
            "creek road again ice least."
        ),
        "forbidden": ["collapse practice feed", "despair creek", "seed phrase"],
        "hostile_facts": [
            {
                "type": "seed_phrase",
                "value": "witch collapse practice feed shame open despair creek road again ice least",
            },
            {"type": "answer_style", "value": "witch collapse practice feed"},
        ],
        "expected": {},
    },
    {
        "name": "balance_net_worth",
        "query": "My account balance is $1,234,567.89 and net worth ~2.5M.",
        "forbidden": ["1,234,567", "1234567", "234567", "2.5m"],
        "hostile_facts": [
            {"type": "account_balance", "value": "$1,234,567.89"},
            {"type": "net_worth", "value": "2500000"},
            {"type": "followed_asset", "value": "1234567"},
            {"type": "leverage_pref", "value": "1234567"},
        ],
        "expected": {},
    },
    {
        "name": "password_api_key",
        "query": "My password is hunter2 and my API key is sk-abc123DEF456ghi789xyz.",
        "forbidden": ["hunter2", "sk-abc123def456ghi789xyz", "abc123def456ghi789"],
        "hostile_facts": [
            {"type": "password", "value": "hunter2"},
            {"type": "api_key", "value": "sk-abc123DEF456ghi789xyz"},
            {"type": "followed_asset", "value": "hunter2"},
        ],
        "expected": {},
    },
]


class NoPIIBattery(unittest.IsolatedAsyncioTestCase):
    """Drives every PII case through the REAL extract() pipeline with a hostile
    scripted model, then asserts (a) nothing sensitive survives, (b) every
    surviving fact is an allowlisted type with a canonical value, and (c) any
    bundled benign preference is preserved."""

    def _assert_all_canonical(self, facts: list[dict[str, Any]]) -> None:
        for f in facts:
            self.assertIn(f["type"], FACT_TYPES, f"off-allowlist type survived: {f}")
            v = f["value"]
            self.assertIsInstance(v, str)
            if f["type"] == "followed_asset":
                self.assertTrue(_TICKER_RE.match(v), f"non-canonical ticker: {f}")
            elif f["type"] == "instrument_pref":
                self.assertIn(v, _INSTRUMENT_PREFS, f)
            elif f["type"] == "leverage_pref":
                self.assertTrue(_LEVERAGE_RE.match(v), f)
            elif f["type"] == "experience_level":
                self.assertIn(v, _EXPERIENCE_LEVELS, f)
            elif f["type"] == "answer_style":
                self.assertIn(v, _ANSWER_STYLES, f)

    def _assert_no_pii(self, result: dict[str, Any], forbidden: list[str]) -> None:
        blob = json.dumps(result).lower()
        for token in forbidden:
            self.assertNotIn(token.lower(), blob, f"PII leaked into memory: {token!r}")

    async def test_pii_battery(self) -> None:
        self.assertGreaterEqual(len(_PII_CASES), 12)  # coverage floor
        for case in _PII_CASES:
            with self.subTest(case=case["name"]):
                router = ScriptedRouter(json.dumps({"facts": case["hostile_facts"]}))
                result = await extract(case["query"], router)
                facts = result["facts"]
                self._assert_all_canonical(facts)
                self._assert_no_pii(result, case["forbidden"])
                by_type = {f["type"]: f["value"] for f in facts}
                self.assertEqual(
                    by_type, case["expected"], f"unexpected surviving facts: {facts}"
                )

    async def test_mixed_keeps_only_trading_prefs(self) -> None:
        # The canonical mixed case from the spec: identity + contact PII bundled
        # with genuine trading preferences. ONLY BTC / perps / 10x may survive;
        # the name and email must be gone.
        query = "I'm John Smith, john@x.com, I trade BTC perps at 10x"
        hostile = ScriptedRouter(
            json.dumps(
                {
                    "facts": [
                        {"type": "full_name", "value": "John Smith"},
                        {"type": "email", "value": "john@x.com"},
                        {"type": "followed_asset", "value": "John"},
                        {"type": "contact", "value": "john@x.com"},
                        {"type": "followed_asset", "value": "BTC", "confidence": 0.9},
                        {"type": "instrument_pref", "value": "perps", "confidence": 0.9},
                        {"type": "leverage_pref", "value": "10x", "confidence": 0.9},
                    ]
                }
            )
        )
        result = await extract(query, hostile)
        by_type = {f["type"]: f["value"] for f in result["facts"]}
        self.assertEqual(
            by_type,
            {"followed_asset": "BTC", "instrument_pref": "perps", "leverage_pref": "10x"},
        )
        blob = json.dumps(result).lower()
        for token in ["john", "smith", "@x.com", "contact", "full_name", "email"]:
            self.assertNotIn(token, blob)


class NoPIIValidatorUnit(unittest.TestCase):
    """Pure-validator counterparts: the same guarantees at the _validate_facts
    boundary, independent of the async pipeline."""

    def test_off_allowlist_pii_types_all_dropped(self) -> None:
        facts = _validate_facts(
            {
                "facts": [
                    {"type": "full_name", "value": "John Smith"},
                    {"type": "email", "value": "a@b.com"},
                    {"type": "phone", "value": "555-123-4567"},
                    {"type": "home_address", "value": "742 Evergreen Terrace"},
                    {"type": "ssn", "value": "123-45-6789"},
                    {"type": "wallet_address", "value": "0xabc123def456"},
                    {"type": "account_balance", "value": "$1,000,000"},
                    {"type": "password", "value": "hunter2"},
                ]
            }
        )
        self.assertEqual(facts, [])

    def test_names_never_pass_as_tickers(self) -> None:
        # The specific leak this battery hardened: an alphabetic name must not
        # be accepted as a "ticker" via the followed_asset path.
        for name in ["John", "Smith", "Alice", "Bob", "JOHN", "Sarah", "Mike"]:
            facts = _validate_facts({"facts": [{"type": "followed_asset", "value": name}]})
            self.assertEqual(facts, [], f"name {name!r} leaked as a ticker")

    def test_recognized_tickers_still_pass(self) -> None:
        # Hardening must not break the happy path: real assets still land.
        for tok, want in [("btc", "BTC"), ("ethereum", "ETH"), ("AVAX", "AVAX"), ("sol", "SOL")]:
            facts = _validate_facts({"facts": [{"type": "followed_asset", "value": tok}]})
            self.assertEqual([f["value"] for f in facts], [want], tok)

    def test_pii_smuggled_into_valid_types_dropped(self) -> None:
        facts = _validate_facts(
            {
                "facts": [
                    {"type": "followed_asset", "value": "john@x.com"},
                    {"type": "answer_style", "value": "+1 555 123 4567"},
                    {"type": "leverage_pref", "value": "4111111111111111"},
                    {"type": "instrument_pref", "value": "0x71C7656EC7ab88b098"},
                    {"type": "experience_level", "value": "123-45-6789"},
                ]
            }
        )
        self.assertEqual(facts, [])

    def test_benign_survives_alongside_pii(self) -> None:
        facts = _validate_facts(
            {
                "facts": [
                    {"type": "full_name", "value": "Jane Doe"},
                    {"type": "email", "value": "jane@doe.com"},
                    {"type": "followed_asset", "value": "ETH"},
                    {"type": "answer_style", "value": "concise"},
                ]
            }
        )
        by_type = {f["type"]: f["value"] for f in facts}
        self.assertEqual(by_type, {"followed_asset": "ETH", "answer_style": "concise"})


if __name__ == "__main__":
    unittest.main()
