"""Small text utilities shared by the intent and research engines."""
from __future__ import annotations

import json
import re

# qwen3-class models emit <think>...</think> reasoning blocks before the
# answer (even with /no_think a stub block may appear). Strip them before any
# JSON parsing. Tolerates an unclosed block (truncated generation) AND an
# orphan close: some servers (observed on Ollama with reasoning_effort=none)
# emit the reasoning in content WITHOUT the opening tag, ending "...</think>".
_THINK_RE = re.compile(r"<think>.*?(?:</think>|\Z)", re.DOTALL | re.IGNORECASE)
_ORPHAN_CLOSE_RE = re.compile(r"\A.*</think>", re.DOTALL | re.IGNORECASE)


def strip_think(text: str) -> str:
    text = _THINK_RE.sub("", text)
    return _ORPHAN_CLOSE_RE.sub("", text).strip()


def extract_json_object(raw: str) -> dict | None:
    """Defensively extract the first balanced JSON object from model output.

    Strips <think> blocks and markdown fences, finds the first balanced {...}
    block, tolerates trailing prose. Returns None if nothing parseable.
    (Same approach as evals/runner/scoring.py:parse_judge_json.)
    """
    text = strip_think(raw)
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start : i + 1])
                    return obj if isinstance(obj, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


def canonical_text(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    lowered = text.lower()
    stripped = re.sub(r"[^\w\s/]", " ", lowered)
    return re.sub(r"\s+", " ", stripped).strip()


_ESCAPE_MAP = {
    "n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f",
    '"': '"', "/": "/", "\\": "\\",
}


class JsonProseExtractor:
    """Incrementally extract readable prose from a streaming JSON brief.

    The research model streams a constrained-JSON object
    ({"headline": "...", "paragraphs": ["...", ...], "followups": [...]})
    but the SDK wants human-readable text deltas. This walks the raw stream
    with a tiny JSON lexer and passes through only the characters inside the
    string values of "headline" and "paragraphs" (decoding escapes), inserting
    a blank line between segments. Chunk boundaries may fall anywhere,
    including mid-escape. Assumes the stream is JSON from the first byte
    (guaranteed by json_mode constrained decoding); the caller finalizes from
    the raw accumulation via extract_json_object either way.
    """

    _PROSE_KEYS = frozenset({"headline", "paragraphs"})

    def __init__(self) -> None:
        self._stack: list[tuple[str, str]] = []  # (container kind, owner key)
        self._expect_key = False
        self._in_string = False
        self._string_is_key = False
        self._prose_string = False
        self._sep_pending = False
        self._emitted_any = False
        self._key_chars: list[str] = []
        self._last_key = ""
        self._escape: str | None = None  # pending escape body (after the \)

    def feed(self, chunk: str) -> str:
        """Consume a raw chunk; return the newly visible prose (may be "")."""
        out: list[str] = []
        for ch in chunk:
            self._consume(ch, out)
        return "".join(out)

    def _consume(self, ch: str, out: list[str]) -> None:
        if self._in_string:
            if self._escape is not None:
                self._escape += ch
                decoded = self._decode_escape()
                if decoded is None:
                    return  # \uXXXX still incomplete
                self._escape = None
                self._string_char(decoded, out)
            elif ch == "\\":
                self._escape = ""
            elif ch == '"':
                self._end_string()
            else:
                self._string_char(ch, out)
            return
        if ch == '"':
            self._start_string()
        elif ch == "{":
            self._stack.append(("obj", self._last_key))
            self._expect_key = True
        elif ch == "[":
            self._stack.append(("arr", self._last_key))
        elif ch in "}]":
            if self._stack:
                self._stack.pop()
        elif ch == ":":
            self._expect_key = False
        elif ch == "," and self._stack and self._stack[-1][0] == "obj":
            self._expect_key = True

    def _decode_escape(self) -> str | None:
        body = self._escape or ""
        if not body:
            return None
        if body[0] == "u":
            if len(body) < 5:
                return None
            try:
                return chr(int(body[1:5], 16))
            except ValueError:
                return body
        return _ESCAPE_MAP.get(body, body)

    def _start_string(self) -> None:
        self._in_string = True
        top = self._stack[-1] if self._stack else ("obj", "")
        if top[0] == "obj" and self._expect_key:
            self._string_is_key = True
            self._key_chars = []
            self._prose_string = False
            return
        self._string_is_key = False
        owner = self._last_key if top[0] == "obj" else top[1]
        self._prose_string = owner in self._PROSE_KEYS
        # Separator is emitted lazily on the first visible char, so empty
        # strings never produce a dangling blank line.
        self._sep_pending = self._prose_string and self._emitted_any

    def _string_char(self, text: str, out: list[str]) -> None:
        if self._string_is_key:
            self._key_chars.append(text)
            return
        if not self._prose_string:
            return
        if self._sep_pending:
            out.append("\n\n")
            self._sep_pending = False
        out.append(text)
        self._emitted_any = True

    def _end_string(self) -> None:
        self._in_string = False
        if self._string_is_key:
            self._last_key = "".join(self._key_chars)
        self._string_is_key = False
        self._prose_string = False
