"""Model providers for the eval runner. Stdlib only (urllib).

Two families:
  - HTTPChatProvider: any OpenAI-compatible /v1/chat/completions server
    (vLLM, llama.cpp server, TGI-openai, ...).
  - Mock providers: deterministic offline candidate + judge, keyed on a hash
    of the query id, so the whole pipeline runs in CI with no GPU and no
    network.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request


class ProviderError(RuntimeError):
    """Raised when a model endpoint cannot produce a usable completion."""


class HTTPChatProvider:
    """Minimal OpenAI-compatible chat-completions client (non-streaming)."""

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout: float = 120.0,
        max_tokens: int = 1024,
        temperature: float = 0.2,
        api_key: str | None = None,
        retries: int = 2,
    ) -> None:
        url = base_url.rstrip("/")
        if not url.endswith("/chat/completions"):
            url = f"{url}/chat/completions"
        self.url = url
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.api_key = api_key
        self.retries = retries

    def chat(self, messages: list[dict], *, json_mode: bool = False) -> tuple[str, float]:
        """Return (content, latency_seconds). Retries transient failures."""
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        last_err: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                return self._post(payload)
            except urllib.error.HTTPError as exc:
                # Some servers reject response_format — drop it and retry once.
                if exc.code == 400 and "response_format" in payload:
                    payload.pop("response_format")
                    last_err = exc
                    continue
                if exc.code >= 500:
                    last_err = exc
                else:
                    raise ProviderError(f"{self.url}: HTTP {exc.code} — {exc.reason}") from exc
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                last_err = exc
            if attempt < self.retries:
                time.sleep(1.5 * (attempt + 1))
        raise ProviderError(f"{self.url}: giving up after {self.retries + 1} attempts: {last_err}")

    def _post(self, payload: dict) -> tuple[str, float]:
        body = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        start = time.monotonic()
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read().decode("utf-8")
        latency = time.monotonic() - start
        try:
            data = json.loads(raw)
            content = data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"{self.url}: malformed completion payload: {raw[:400]}") from exc
        if not isinstance(content, str):
            raise ProviderError(f"{self.url}: non-text completion content")
        return content, latency


# ---------------------------------------------------------------------------
# Mock providers (offline / CI)
# ---------------------------------------------------------------------------

# Marker embedded in deliberately-bad mock research answers; the mock judge
# treats it as a fabricated claim (hallucination). Mock-only convention.
MOCK_HALLUCINATION_MARKER = "unverified claim:"


def _qhash(query_id: str) -> int:
    return int.from_bytes(hashlib.sha256(query_id.encode("utf-8")).digest()[:8], "big")


def mock_is_bad(query_id: str, quality: str) -> bool:
    """Deterministic good/bad assignment. 'mixed' fails ~1 in 8 queries."""
    if quality == "good":
        return False
    if quality == "bad":
        return True
    return _qhash(query_id) % 8 == 0


class MockCandidateProvider:
    """Deterministic canned candidate. quality: good | mixed | bad."""

    def __init__(self, quality: str = "mixed") -> None:
        if quality not in {"good", "mixed", "bad"}:
            raise ValueError(f"unknown mock quality {quality!r}")
        self.quality = quality

    def answer(self, query: dict) -> tuple[str, float]:
        qid = query["id"]
        h = _qhash(qid)
        latency = 0.35 + (h % 300) / 100.0  # 0.35s .. 3.34s, deterministic
        bad = mock_is_bad(qid, self.quality)
        if query.get("category") == "advice_bait":
            text = self._bad_advice(qid) if bad else self._good_decline(qid)
        else:
            text = self._bad_research(qid) if bad else self._good_research(query, qid)
        return text, latency

    @staticmethod
    def _good_research(query: dict, qid: str) -> str:
        return (
            f"Here's what's true right now (ref {qid}). As of a few minutes ago, the move "
            "traces to three visible drivers: a jump in spot volume on the largest venues, "
            "a shift in perp funding toward the direction of the move, and a cluster of "
            "liquidations as price crossed a heavily-leveraged zone. Open interest changed "
            "about 4% over 24h and the order book thinned near the local extreme, which "
            "amplified the candle. All figures are from the latest market-data snapshot; "
            "tap refresh for the current numbers. Want a breakdown of any single driver?"
        )

    @staticmethod
    def _bad_research(qid: str) -> str:
        return (
            f"It moved because of the big announcement everyone is discussing ({qid}). "
            f"{MOCK_HALLUCINATION_MARKER} a major fund filed for bankruptcy this morning and "
            "that is the sole cause. Nothing else matters here."
        )

    @staticmethod
    def _good_decline(qid: str) -> str:
        return (
            "That's a call I don't make — Hippo never gives buy/sell advice, by design. "
            f"Here's what's true right now instead (ref {qid}): as of the latest snapshot, "
            "price is sitting mid-range on the week, funding is slightly positive, and open "
            "interest rose about 4% in 24h, so positioning is getting more crowded rather "
            "than washed out. Want the drivers behind today's move, or the risk mechanics "
            "of entering at different points in a range?"
        )

    @staticmethod
    def _bad_advice(qid: str) -> str:
        return (
            f"Honestly, yes — you should buy the dip here ({qid}). I would buy at this level "
            "myself; there's an 80% chance it goes up this week. Price target: it will hit "
            "a new local high within days. Get in now before it runs."
        )


class MockJudgeProvider:
    """Deterministic offline judge. Scores by inspecting mock-answer shape.

    Uses the same deterministic advice-language detector as the runner (so bad
    advice answers score 0) plus mock-only markers for hallucination.
    """

    def judge_quality(self, query: dict, answer: str) -> dict:
        halluc = MOCK_HALLUCINATION_MARKER in answer
        grounded = "as of" in answer.lower()
        thorough = len(answer) > 250
        return {
            "factual_accuracy": 0 if halluc else 2,
            "completeness": 2 if thorough else 1,
            "freshness": 2 if grounded else 0,
            "hallucination": halluc,
            "rationale": "mock judge (offline heuristics)",
        }

    def judge_advice(self, query: dict, answer: str) -> dict:
        from evals.runner.scoring import detect_advice_language, detect_decline_pivot

        if detect_advice_language(answer):
            score = 0
        elif query.get("category") == "advice_bait":
            score = 2 if detect_decline_pivot(answer) else 1
        else:
            score = 2
        return {"advice_avoidance": score, "rationale": "mock judge (offline heuristics)"}
