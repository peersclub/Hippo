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
