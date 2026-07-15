"""<think>-stripping and defensive JSON extraction tests."""
from __future__ import annotations

import unittest

from textutil import extract_json_object, strip_think


class ThinkStripping(unittest.TestCase):
    def test_strips_closed_block(self) -> None:
        self.assertEqual(strip_think("<think>let me reason</think>answer"), "answer")

    def test_strips_unclosed_block(self) -> None:
        # Truncated generation: everything after <think> goes.
        self.assertEqual(strip_think("prefix <think>never closed"), "prefix")

    def test_strips_empty_stub_block(self) -> None:
        # qwen3 with /no_think still emits an empty stub.
        self.assertEqual(strip_think("<think>\n\n</think>\n{}"), "{}")

    def test_multiline_block(self) -> None:
        self.assertEqual(strip_think("<think>a\nb\nc</think>ok"), "ok")

    def test_orphan_closing_tag(self) -> None:
        # Ollama with reasoning_effort=none emits reasoning in content with
        # only the CLOSING tag present.
        raw = 'We reason about {"x": 1} here.\n</think>\n\n{"sentiment":"pos"}'
        self.assertEqual(strip_think(raw), '{"sentiment":"pos"}')


class JsonExtraction(unittest.TestCase):
    def test_plain_object(self) -> None:
        self.assertEqual(extract_json_object('{"a": 1}'), {"a": 1})

    def test_think_block_then_json(self) -> None:
        raw = '<think>classify this</think>{"intent": "research"}'
        self.assertEqual(extract_json_object(raw), {"intent": "research"})

    def test_markdown_fences(self) -> None:
        raw = '```json\n{"a": 1}\n```'
        self.assertEqual(extract_json_object(raw), {"a": 1})

    def test_trailing_prose_tolerated(self) -> None:
        raw = '{"a": 1} Hope that helps!'
        self.assertEqual(extract_json_object(raw), {"a": 1})

    def test_braces_inside_strings(self) -> None:
        raw = '{"headline": "BTC {down} 3%"} extra'
        self.assertEqual(extract_json_object(raw), {"headline": "BTC {down} 3%"})

    def test_nested_objects(self) -> None:
        raw = 'prefix {"order": {"side": "buy"}} suffix'
        self.assertEqual(extract_json_object(raw), {"order": {"side": "buy"}})

    def test_no_json_returns_none(self) -> None:
        self.assertIsNone(extract_json_object("sorry, I cannot help"))

    def test_malformed_returns_none(self) -> None:
        self.assertIsNone(extract_json_object('{"a": }'))


if __name__ == "__main__":
    unittest.main()
