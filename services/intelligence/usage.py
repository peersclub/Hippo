"""In-process LLM token metering — the measured side of cost/MAU.

Every real provider call records its token usage here, tagged with the purpose
that made it (interpret / research / memory-extract / file-analysis) and the
model that served it. The admin Pilot dashboard reads GET /admin/usage and
multiplies measured tokens by its configured prices — replacing the
assumption-based estimator whenever this data exists.

Deliberately in-memory and reset-on-boot, like the gateway snapshot counters
(the dashboard labels the provenance). Mock calls are never metered — they
cost nothing. Calls whose response carried no usage block are counted as
`unmetered` so the dashboard can say "N calls unaccounted" instead of silently
under-reporting spend.
"""
from __future__ import annotations

import time
from threading import Lock
from typing import Any


def parse_openai_usage(obj: Any) -> tuple[int, int] | None:
    """(prompt, completion) tokens from an OpenAI-compat response or final
    stream chunk; None when absent/malformed (some servers omit usage)."""
    if not isinstance(obj, dict):
        return None
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return None
    p, c = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if isinstance(p, int) and isinstance(c, int) and p >= 0 and c >= 0:
        return (p, c)
    return None


def parse_ollama_usage(obj: Any) -> tuple[int, int] | None:
    """Ollama native counts (prompt_eval_count/eval_count) from the done
    chunk / non-stream response; None when the server omitted them."""
    if not isinstance(obj, dict):
        return None
    p, c = obj.get("prompt_eval_count"), obj.get("eval_count")
    if isinstance(p, int) and isinstance(c, int) and p >= 0 and c >= 0:
        return (p, c)
    return None


class UsageMeter:
    """Rolling since-boot totals, by purpose and by model. All O(1) writes
    behind a lock — this sits on the model-call path and must never slow it."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.boot_at = time.time()
        self.calls = 0
        self.unmetered = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.by_purpose: dict[str, dict[str, int]] = {}
        self.by_model: dict[str, dict[str, int]] = {}

    def record(self, purpose: str, model: str, usage: tuple[int, int] | None) -> None:
        with self._lock:
            self.calls += 1
            if usage is None:
                self.unmetered += 1
                # Still count the call under its purpose — call volume is real
                # even when the server withheld token counts.
                bucket = self.by_purpose.setdefault(
                    purpose, {"calls": 0, "promptTokens": 0, "completionTokens": 0}
                )
                bucket["calls"] += 1
                return
            p, c = usage
            self.prompt_tokens += p
            self.completion_tokens += c
            for key, table in ((purpose, self.by_purpose), (model, self.by_model)):
                bucket = table.setdefault(
                    key, {"calls": 0, "promptTokens": 0, "completionTokens": 0}
                )
                bucket["calls"] += 1
                bucket["promptTokens"] += p
                bucket["completionTokens"] += c

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "bootAt": int(self.boot_at * 1000),
                "calls": self.calls,
                "unmetered": self.unmetered,
                "promptTokens": self.prompt_tokens,
                "completionTokens": self.completion_tokens,
                "byPurpose": {k: dict(v) for k, v in self.by_purpose.items()},
                "byModel": {k: dict(v) for k, v in self.by_model.items()},
            }


meter = UsageMeter()
