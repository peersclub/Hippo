"""Token-metering tests: parser strictness, meter accumulation, and the
router forwarding the purpose tag to the real provider (never the mock)."""
from __future__ import annotations

import unittest
from typing import Any, AsyncIterator

from providers import ProviderRouter
from usage import UsageMeter, parse_ollama_usage, parse_openai_usage


class TestParsers(unittest.TestCase):
    def test_openai_usage_happy_path(self) -> None:
        obj = {"usage": {"prompt_tokens": 120, "completion_tokens": 45}}
        self.assertEqual(parse_openai_usage(obj), (120, 45))

    def test_openai_usage_rejects_missing_or_malformed(self) -> None:
        for bad in (
            None,
            {},
            {"usage": None},
            {"usage": {"prompt_tokens": 120}},
            {"usage": {"prompt_tokens": "120", "completion_tokens": 45}},
            {"usage": {"prompt_tokens": -1, "completion_tokens": 45}},
        ):
            self.assertIsNone(parse_openai_usage(bad), msg=repr(bad))

    def test_ollama_usage(self) -> None:
        self.assertEqual(
            parse_ollama_usage({"prompt_eval_count": 80, "eval_count": 33, "done": True}),
            (80, 33),
        )
        self.assertIsNone(parse_ollama_usage({"done": True}))


class TestMeter(unittest.TestCase):
    def test_accumulates_by_purpose_and_model(self) -> None:
        m = UsageMeter()
        m.record("interpret", "haiku", (100, 20))
        m.record("interpret", "haiku", (150, 30))
        m.record("research", "haiku", (900, 500))
        snap = m.snapshot()
        self.assertEqual(snap["calls"], 3)
        self.assertEqual(snap["unmetered"], 0)
        self.assertEqual(snap["promptTokens"], 1150)
        self.assertEqual(snap["completionTokens"], 550)
        self.assertEqual(
            snap["byPurpose"]["interpret"],
            {"calls": 2, "promptTokens": 250, "completionTokens": 50},
        )
        self.assertEqual(snap["byModel"]["haiku"]["calls"], 3)

    def test_unmetered_calls_count_volume_but_no_tokens(self) -> None:
        m = UsageMeter()
        m.record("research", "haiku", None)
        snap = m.snapshot()
        self.assertEqual(snap["calls"], 1)
        self.assertEqual(snap["unmetered"], 1)
        self.assertEqual(snap["promptTokens"], 0)
        self.assertEqual(snap["byPurpose"]["research"]["calls"], 1)
        self.assertNotIn("haiku", snap["byModel"])

    def test_snapshot_is_a_copy(self) -> None:
        m = UsageMeter()
        m.record("research", "haiku", (1, 1))
        snap = m.snapshot()
        snap["byPurpose"]["research"]["calls"] = 999
        self.assertEqual(m.snapshot()["byPurpose"]["research"]["calls"], 1)


class RecordingLlm:
    """Stub provider that records the kwargs the router forwards."""

    model = "stub-model"

    def __init__(self) -> None:
        self.chat_kwargs: list[dict[str, Any]] = []
        self.stream_kwargs: list[dict[str, Any]] = []

    async def probe(self) -> bool:
        return True

    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        self.chat_kwargs.append(kwargs)
        return '{"ok": true}'

    async def chat_stream(
        self, messages: list[dict[str, str]], **kwargs: Any
    ) -> AsyncIterator[str]:
        self.stream_kwargs.append(kwargs)
        yield "chunk"


class TestRouterForwardsPurpose(unittest.IsolatedAsyncioTestCase):
    async def test_chat_forwards_purpose(self) -> None:
        llm = RecordingLlm()
        router = ProviderRouter(llm=llm)  # type: ignore[arg-type]
        await router.chat([{"role": "user", "content": "hi"}], purpose="interpret")
        self.assertEqual(llm.chat_kwargs[0].get("purpose"), "interpret")

    async def test_chat_stream_forwards_purpose(self) -> None:
        llm = RecordingLlm()
        router = ProviderRouter(llm=llm)  # type: ignore[arg-type]
        chunks = [
            c
            async for c in router.chat_stream(
                [{"role": "user", "content": "hi"}], purpose="research"
            )
        ]
        self.assertEqual(chunks, ["chunk"])
        self.assertEqual(llm.stream_kwargs[0].get("purpose"), "research")


if __name__ == "__main__":
    unittest.main()
