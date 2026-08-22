"""Answer-language plumbing + protocol parity.

Two shipped bugs this file exists to catch, both silent:

  * LANGUAGE ENUM DRIFT: the protocol's SettingsUplink admits
    ['en','hi','hinglish','ar'] and the gateway forwards session.language
    verbatim, but AnalyzeFileRequest's Literal knew only three values — an
    Arabic session's CSV/image upload failed validation (422 → gateway saw
    non-2xx → upload marked failed). Same drift class as the intent-taxonomy
    parity tests, so the same fix: read the protocol enum as TEXT and assert
    SET EQUALITY against every Python-side language site.
  * INSTRUCTION TOO THIN: the research prompt carried the bare wire code
    ("ANSWER LANGUAGE: hinglish"), which models routinely ignored — the SDK's
    language picker changed chip labels while answers stayed English. The
    prompt now carries a spelled-out per-language directive.

All offline and pure: no provider, no network.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any, get_args
from unittest.mock import patch

import research
from cache import AnswerCache
from fileanalysis import _csv_user_prompt, _image_user_text
from main import AnalyzeFileRequest, RespondRequest
from prompts import SUPPORTED_LANGUAGES, answer_language_line, coerce_language
from providers import ProviderRouter
from research import _brief_user_prompt

REPO_ROOT = Path(__file__).resolve().parents[3]
UPLINKS_TS = REPO_ROOT / "packages" / "protocol" / "src" / "uplinks.ts"


def protocol_languages() -> set[str]:
    """The SettingsUplink language enum, read as text. Fails loudly if the
    enum moves — a parity test that silently matches nothing must not pass."""
    src = UPLINKS_TS.read_text(encoding="utf-8")
    m = re.search(r"language:\s*z\.enum\(\[([^\]]*)\]\)", src)
    if m is None:
        raise AssertionError(f"no `language: z.enum([...])` in {UPLINKS_TS}")
    return set(re.findall(r"['\"]([a-zA-Z-]+)['\"]", m.group(1)))


def literal_languages(model: Any, field: str) -> set[str]:
    """Values of a pydantic `Literal[...] | None` annotation."""
    ann = model.model_fields[field].annotation
    return {value for arg in get_args(ann) for value in get_args(arg)}


class ProtocolParity(unittest.TestCase):
    def test_supported_languages_match_the_protocol_enum(self) -> None:
        self.assertEqual(protocol_languages(), set(SUPPORTED_LANGUAGES))

    def test_respond_request_admits_every_protocol_language(self) -> None:
        self.assertEqual(literal_languages(RespondRequest, "language"), set(SUPPORTED_LANGUAGES))

    def test_analyze_file_request_admits_every_protocol_language(self) -> None:
        # THE ar bug: this Literal was ("en","hi","hinglish") while the SDK
        # offered ar and the gateway forwarded it on every upload.
        self.assertEqual(
            literal_languages(AnalyzeFileRequest, "language"), set(SUPPORTED_LANGUAGES)
        )

    def test_arabic_upload_passes_request_validation(self) -> None:
        # Regression: before the fix both of these raised ValidationError,
        # which surfaced as a failed upload for every Arabic-language session.
        AnalyzeFileRequest(kind="csv", name="pnl.csv", language="ar", digest={})
        AnalyzeFileRequest(
            kind="image", name="chart.png", language="ar", mime="image/png", dataBase64="aGk="
        )

    def test_arabic_respond_passes_request_validation(self) -> None:
        RespondRequest(text="btc kaif al-halah?", intent="research", language="ar")


class LanguageDirective(unittest.TestCase):
    def test_every_supported_language_has_its_own_directive(self) -> None:
        seen: dict[str, str] = {}
        for lang in SUPPORTED_LANGUAGES:
            with self.subTest(lang=lang):
                line = answer_language_line(lang)
                self.assertTrue(line.startswith("ANSWER LANGUAGE:"), line)
                self.assertNotIn(line, seen, f"{lang} reuses {seen.get(line)}'s directive")
                seen[line] = lang

    def test_unknown_or_absent_language_defaults_to_english(self) -> None:
        self.assertEqual(answer_language_line(None), "ANSWER LANGUAGE: English.")
        self.assertEqual(answer_language_line("fr"), "ANSWER LANGUAGE: English.")
        self.assertEqual(coerce_language(None), "en")
        self.assertEqual(coerce_language("fr"), "en")
        for lang in SUPPORTED_LANGUAGES:
            self.assertEqual(coerce_language(lang), lang)

    def test_research_prompt_carries_a_spelled_out_directive(self) -> None:
        # Regression: the prompt used to carry the bare wire code, which the
        # model ignored — answers stayed English whatever the picker said.
        cases = {
            "hi": ("Hindi", "Devanagari"),
            "hinglish": ("Hinglish", "Latin script"),
            "ar": ("Arabic",),
            "en": ("English",),
        }
        for lang, needles in cases.items():
            with self.subTest(lang=lang):
                prompt = _brief_user_prompt("why is btc down", "BTC", None, lang)
                for needle in needles:
                    self.assertIn(needle, prompt)
                self.assertNotIn(f"ANSWER LANGUAGE: {lang}\n", prompt + "\n")

    def test_file_prompts_carry_the_same_directive(self) -> None:
        self.assertIn("Arabic", _csv_user_prompt("pnl.csv", "{}", "ar"))
        self.assertIn("Devanagari", _image_user_text("chart.png", "hi"))


SNAPSHOT: dict[str, Any] = {
    "symbol": "BTC/USDT",
    "last": 64732.22,
    "lastDisplay": "64,732",
    "change12hPct": -2.1,
    "change12hDisplay": "-2.1%",
    "fundingRate": 0.0001,
    "fundingDisplay": "+0.010%",
    "spark": [64730, 64621, 64571, 64569, 64572, 64676, 64860],
    "asOfIso": "2026-07-15T04:32:17.928Z",
    "sources": ["BINANCE PUBLIC", "FUNDING"],
}


async def fake_snapshot(symbol: str, timeout: float = 3.0) -> dict | None:
    return dict(SNAPSHOT)


def offline_router() -> ProviderRouter:
    router = ProviderRouter()
    router._down_until = float("inf")  # never even try the LLM endpoint
    return router


class ArabicRespond(unittest.IsolatedAsyncioTestCase):
    async def test_ar_never_serves_the_english_cache_entry(self) -> None:
        # Regression: respond() coerced unknown languages to "en", and "ar"
        # was unknown — an Arabic session shared the English cache scope and
        # was served the cached English brief.
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            en = await research.respond(
                "why is btc down", "research", router, cache, language="en"
            )
            ar = await research.respond(
                "why is btc down", "research", router, cache, language="ar"
            )
        self.assertFalse(en["cached"])
        self.assertFalse(ar["cached"])  # an Arabic asker never gets the English brief

    async def test_ar_scopes_the_cache_key(self) -> None:
        self.assertNotEqual(
            research._cache_scope("BTC", False, "ar", None),
            research._cache_scope("BTC", False, "en", None),
        )

    async def test_advice_decline_localized_in_arabic(self) -> None:
        router, cache = offline_router(), AnswerCache()
        with patch.object(research, "fetch_snapshot", fake_snapshot):
            out = await research.respond(
                "hal ashtari btc?", "advice", router, cache, language="ar"
            )
        self.assertEqual(out["kind"], "decline")
        self.assertIn("هيبو", out["message"])


if __name__ == "__main__":
    unittest.main()
