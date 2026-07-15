"""Provider layer: OpenAI-compatible chat client with a deterministic mock.

Both vLLM (production) and Ollama (local dev) serve the same
POST /v1/chat/completions surface — the service is built against that
abstraction, so the vLLM swap is purely LLM_BASE_URL/LLM_MODEL config.

Env:
  LLM_BASE_URL  (default http://localhost:11434/v1 — local Ollama)
  LLM_MODEL     (default qwen3:4b)
  LLM_API_KEY   (optional; sent as Bearer token — vLLM deployments may require it)
  LLM_TIMEOUT   (seconds, default 30)

Availability rule: the service NEVER 500s because the model is down. The
router health-probes on startup and falls back per-request to the MOCK
provider (deterministic, seeded by input hash); /health reflects the mode.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any

import httpx

Message = dict[str, str]

LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:11434/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3:4b")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "30"))

# After a failed LLM call, skip straight to mock for this long (avoids paying
# a connect timeout on every request while the model is down); the next
# request after the window retries the LLM.
_BREAKER_SECONDS = 30.0


class ProviderError(Exception):
    """The LLM endpoint was unreachable or returned an unusable response."""


def _seed(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:12], 16)


class OpenAICompatProvider:
    """Minimal OpenAI-compatible /chat/completions client (Ollama or vLLM).

    Ollama quirk (measured, qwen3:4b on Ollama ≥0.12): the hybrid-thinking
    model reasons into a SEPARATE `reasoning` channel that (a) cannot be
    disabled through the OpenAI-compatible surface and (b) consumes the whole
    max_tokens budget before `content` gets a single token — every call comes
    back with empty content. Ollama's NATIVE /api/chat with `think: false`
    (+ `format: "json"` for strict-JSON calls) is the designed off-switch, so
    when the endpoint identifies itself as Ollama (GET /api/version) we route
    through the native API. vLLM and every other OpenAI-compatible server use
    the standard path; the production swap remains pure LLM_BASE_URL config.
    """

    def __init__(
        self,
        base_url: str = LLM_BASE_URL,
        model: str = LLM_MODEL,
        api_key: str = LLM_API_KEY,
        timeout: float = LLM_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        # None = not yet detected; "openai" | "ollama" once detected.
        self._flavor: str | None = None

    @property
    def _origin(self) -> str:
        """Server origin without the /v1 suffix (for Ollama's native API)."""
        return self.base_url.removesuffix("/v1")

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _detect_flavor(self, client: httpx.AsyncClient) -> str:
        """Identify Ollama by its native version endpoint; cache the answer."""
        if self._flavor is None:
            try:
                res = await client.get(f"{self._origin}/api/version", timeout=2.0)
                self._flavor = "ollama" if res.status_code == 200 else "openai"
            except httpx.HTTPError:
                self._flavor = "openai"
        return self._flavor

    async def chat(
        self,
        messages: list[Message],
        *,
        temperature: float = 0.2,
        # Generous cap: with json_mode the model stops at the closing brace
        # long before this; without it, prose briefs stay well under.
        max_tokens: int = 2000,
        # Strict-JSON calls (intent classification, brief generation) request
        # constrained decoding: response_format json_object on OpenAI-compat
        # servers (vLLM supports it via guided decoding), format:"json" on
        # native Ollama.
        json_mode: bool = False,
    ) -> str:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                if await self._detect_flavor(client) == "ollama":
                    content = await self._chat_ollama_native(
                        client, messages, temperature, max_tokens, json_mode
                    )
                else:
                    content = await self._chat_openai(
                        client, messages, temperature, max_tokens, json_mode
                    )
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as err:
            raise ProviderError(f"llm call failed: {err}") from err
        if not isinstance(content, str) or not content.strip():
            raise ProviderError("llm returned empty content")
        return content

    async def _chat_openai(
        self,
        client: httpx.AsyncClient,
        messages: list[Message],
        temperature: float,
        max_tokens: int,
        json_mode: bool,
    ) -> object:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        res = await client.post(
            f"{self.base_url}/chat/completions",
            json=payload,
            headers=self._headers(),
        )
        res.raise_for_status()
        return res.json()["choices"][0]["message"]["content"]

    async def _chat_ollama_native(
        self,
        client: httpx.AsyncClient,
        messages: list[Message],
        temperature: float,
        max_tokens: int,
        json_mode: bool,
    ) -> object:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,  # the actual off-switch for hybrid-thinking models
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        if json_mode:
            payload["format"] = "json"
        res = await client.post(f"{self._origin}/api/chat", json=payload)
        res.raise_for_status()
        return res.json()["message"]["content"]

    async def probe(self) -> bool:
        """True if the endpoint answers and (when listable) serves our model."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await self._detect_flavor(client)
                res = await client.get(
                    f"{self.base_url}/models", headers=self._headers()
                )
                res.raise_for_status()
                data = res.json()
        except (httpx.HTTPError, ValueError):
            return False
        models = data.get("data") if isinstance(data, dict) else None
        if isinstance(models, list) and models:
            ids = {m.get("id") for m in models if isinstance(m, dict)}
            return self.model in ids
        # Endpoint is up but the model list is empty/opaque (e.g. Ollama with
        # a pull still in progress) — treat as unavailable; per-request retry
        # will promote us to llm mode the moment the model responds.
        return False


class MockProvider:
    """Deterministic offline provider, seeded by input hash.

    Produces good-quality canned outputs for every task the engines ask for.
    It recognizes the task by the prompt shape (built in prompts.py):
    intent classification returns rule-derived strict JSON; research briefs
    return templated factual prose grounded in the SNAPSHOT JSON block that
    research.py embeds in the user prompt — the mock never invents numbers
    either.
    """

    model = "mock"

    async def chat(
        self,
        messages: list[Message],
        *,
        temperature: float = 0.2,
        max_tokens: int = 2000,
        json_mode: bool = False,
    ) -> str:
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        user = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
        )
        if "You classify one user message" in system:
            return self._classify(user)
        if '"headline"' in user or '"headline"' in system:
            return self._brief(user)
        return "As of now, here is what the data shows."

    # -- intent -----------------------------------------------------------
    def _classify(self, user: str) -> str:
        # Lazy import: intent.py owns the deterministic heuristics (also used
        # as the LLM-parse-failure fallback); importing here at module level
        # would be circular.
        from intent import rule_classify

        text = user.removesuffix("/no_think").strip()
        result = rule_classify(text)
        return json.dumps(result)

    # -- research brief -----------------------------------------------------
    def _brief(self, user: str) -> str:
        snapshot = self._embedded_snapshot(user)
        question = ""
        for line in user.splitlines():
            if line.startswith("QUESTION:"):
                question = line.removeprefix("QUESTION:").strip()
                break
        seed = _seed(question or user)

        if snapshot is None:
            return json.dumps(self._concept_brief(question, seed))
        return json.dumps(self._market_brief(question, snapshot, seed))

    @staticmethod
    def _embedded_snapshot(user: str) -> dict | None:
        marker = "SNAPSHOT JSON:"
        idx = user.find(marker)
        if idx == -1:
            return None
        rest = user[idx + len(marker) :].strip()
        end = rest.find("\n")
        line = rest if end == -1 else rest[:end]
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _market_brief(question: str, snap: dict, seed: int) -> dict:
        sym = str(snap.get("symbol", "BTC/USDT")).split("/")[0]
        last = snap.get("lastDisplay", "?")
        change = snap.get("change12hDisplay", "?")
        funding = snap.get("fundingDisplay")
        as_of = snap.get("asOfIso", "")
        negative_funding = str(funding).startswith(("-", "−"))  # ASCII or U+2212
        direction = "up" if str(change).startswith("+") else "down"
        headlines = [
            f"{sym} is {direction} {change} over the last 12 hours",
            f"{sym} trades at {last}, {change} across the 12h window",
        ]
        funding_clause = (
            f"Perp funding sits at {funding}, meaning "
            + (
                "shorts are paying longs — positioning leans short."
                if negative_funding
                else "longs are paying shorts — positioning leans long."
            )
            if funding
            else "Funding data is not available for this instrument right now."
        )
        paragraphs = [
            f"As of {as_of}, {sym} is trading at {last}, {change} over the "
            f"last 12 hours. The move is visible across the hourly closes in "
            f"the same window.",
            funding_clause,
        ]
        followups = [
            f"What is {sym} funding telling us right now?",
            f"How volatile has {sym} been over the last 12 hours?",
        ]
        return {
            "headline": headlines[seed % len(headlines)],
            "paragraphs": paragraphs,
            "followups": followups,
        }

    @staticmethod
    def _concept_brief(question: str, seed: int) -> dict:
        q = question.lower()
        explainers: list[tuple[tuple[str, ...], str, list[str]]] = [
            (
                ("funding",),
                "Funding is a periodic payment between perp traders",
                [
                    "Perpetual futures have no expiry, so exchanges use a "
                    "funding rate to tether the perp price to spot. When the "
                    "perp trades above spot, longs pay shorts; below spot, "
                    "shorts pay longs.",
                    "Positive funding is often read as long-heavy "
                    "positioning; extreme readings historically precede "
                    "sharper two-way moves.",
                ],
            ),
            (
                ("liquidat",),
                "Liquidation is the forced close of a leveraged position",
                [
                    "When a leveraged position's losses approach its margin, "
                    "the exchange force-closes it to keep the account from "
                    "going negative. Cascades happen when forced selling "
                    "pushes price into the next cluster of liquidation "
                    "levels.",
                    "Liquidation data is often used to gauge where leverage "
                    "was concentrated after a sharp move.",
                ],
            ),
            (
                ("leverage", "margin"),
                "Leverage multiplies exposure using borrowed funds",
                [
                    "Leverage lets a trader control a position larger than "
                    "their capital by posting margin. It multiplies both "
                    "gains and losses, and past a threshold the position is "
                    "liquidated.",
                    "Higher leverage means a smaller adverse move wipes the "
                    "margin — the mechanics are symmetric even when outcomes "
                    "are not.",
                ],
            ),
            (
                ("limit order", "market order", "order type"),
                "Market orders take liquidity; limit orders provide it",
                [
                    "A market order executes immediately at the best "
                    "available price, paying the spread. A limit order rests "
                    "in the book at your chosen price and only fills if the "
                    "market reaches it.",
                    "The trade-off is certainty of execution versus "
                    "certainty of price.",
                ],
            ),
        ]
        for keywords, headline, paragraphs in explainers:
            if any(k in q for k in keywords):
                return {
                    "headline": headline,
                    "paragraphs": paragraphs,
                    "followups": [
                        "How is this measured on this exchange?",
                        "What market conditions make this matter most?",
                    ],
                }
        generic = [
            "Here is the concept behind your question",
            "The mechanics behind your question, briefly",
        ]
        return {
            "headline": generic[seed % len(generic)],
            "paragraphs": [
                "This is a mechanics question rather than a live-market one, "
                "so no snapshot data is needed. The short version: crypto "
                "market structure concepts describe how orders, leverage and "
                "settlement interact on an exchange.",
                "Ask about a specific term — funding, liquidation, leverage, "
                "order types — for a precise explanation.",
            ],
            "followups": [
                "What is a funding rate?",
                "How do liquidations work?",
            ],
        }


class ProviderRouter:
    """Tries the LLM, transparently falls back to the mock. Never raises."""

    def __init__(self, llm: OpenAICompatProvider | None = None) -> None:
        self.llm = llm or OpenAICompatProvider()
        self.mock = MockProvider()
        self.mode: str = "mock"  # honest default until a probe/call succeeds
        self._down_until: float = 0.0

    async def startup_probe(self) -> None:
        self.mode = "llm" if await self.llm.probe() else "mock"

    async def chat(
        self,
        messages: list[Message],
        *,
        temperature: float = 0.2,
        max_tokens: int = 2000,
        json_mode: bool = False,
    ) -> str:
        if time.monotonic() >= self._down_until:
            try:
                content = await self.llm.chat(
                    messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    json_mode=json_mode,
                )
                self.mode = "llm"
                return content
            except ProviderError:
                self._down_until = time.monotonic() + _BREAKER_SECONDS
                self.mode = "mock"
        return await self.mock.chat(
            messages, temperature=temperature, max_tokens=max_tokens
        )

    @property
    def model(self) -> str:
        return self.llm.model if self.mode == "llm" else "mock"
