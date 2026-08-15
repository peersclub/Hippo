"""Two ways to get an intent classification. Stdlib only.

- `OfflineRuleClassifier` imports `rule_classify` out of
  `services/intelligence/intent.py` by path, so the deterministic classifier
  can be graded on a laptop with no server, no GPU, and no LLM.
- `HTTPIntentClassifier` posts to a running intelligence service's
  `POST /v1/intent`, which grades the full pipeline (fast path → LLM → rules).

The offline path is the one CI runs; it is the only backend whose numbers are
reproducible bit-for-bit.
"""
from __future__ import annotations

import json
import sys
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

from evals.runner.providers import ProviderError

# Modules `intent.py` pulls in by bare name. They must resolve to the service's
# copies, not to same-named modules already loaded from elsewhere (the eval
# runner ships its own `prompts`, and Python puts the script's directory on
# sys.path when run.py is executed directly).
_SERVICE_MODULES = ("intent", "marketdata", "providers", "prompts", "textutil", "usage")


def _install_httpx_stub() -> bool:
    """Stand in for httpx when it is not installed. Returns True if stubbed.

    `marketdata` and `providers` import httpx at module scope for their HTTP
    clients; nothing on the `rule_classify` path ever calls it. Stubbing keeps
    the harness honest to its stdlib-only contract instead of demanding a pip
    install to grade a pile of regexes.
    """
    try:
        import httpx  # noqa: F401
        return False
    except ModuleNotFoundError:
        pass

    stub = types.ModuleType("httpx")

    class _Unavailable:
        def __init__(self, *_args, **_kwargs):
            raise RuntimeError(
                "httpx is stubbed out by the eval harness; the offline intent "
                "backend must not make network calls"
            )

    for name in ("AsyncClient", "Client", "Timeout", "Limits", "Response",
                 "AsyncHTTPTransport", "HTTPTransport"):
        setattr(stub, name, _Unavailable)
    for name in ("HTTPError", "RequestError", "TimeoutException", "ReadTimeout",
                 "ConnectError", "HTTPStatusError"):
        setattr(stub, name, type(name, (Exception,), {}))
    stub.__doc__ = "minimal stub installed by evals.runner.intent_backends"
    sys.modules["httpx"] = stub
    return True


def load_rule_classify(service_dir: Path):
    """Import `rule_classify` from services/intelligence/intent.py by path.

    Returns (callable, note) where `note` records how the import was made, so
    the report can say plainly what was graded.
    """
    intent_py = service_dir / "intent.py"
    if not intent_py.exists():
        raise ProviderError(f"no intent.py at {intent_py}")

    stubbed = _install_httpx_stub()
    # Evict same-named modules loaded from anywhere else, then put the service
    # directory first so its siblings win the bare-name imports.
    for name in _SERVICE_MODULES:
        module = sys.modules.get(name)
        origin = getattr(module, "__file__", None) if module else None
        if module is not None and (origin is None or Path(origin).parent != service_dir):
            del sys.modules[name]
    if str(service_dir) in sys.path:
        sys.path.remove(str(service_dir))
    sys.path.insert(0, str(service_dir))
    try:
        import intent as intent_module  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover - surfaced as a runner error
        raise ProviderError(f"cannot import {intent_py}: {exc}") from exc

    note = f"rule_classify from {intent_py}"
    if stubbed:
        note += " (httpx stubbed — no network on this path)"
    return intent_module.rule_classify, note


class OfflineRuleClassifier:
    """Grades the deterministic classifier: fast paths + rule fallback, no LLM."""

    def __init__(self, service_dir: Path) -> None:
        self._classify, self.note = load_rule_classify(service_dir)

    @property
    def name(self) -> str:
        return f"offline rule_classify — {self.note}"

    def classify(self, text: str) -> tuple[dict, float]:
        start = time.monotonic()
        result = self._classify(text)
        return result, time.monotonic() - start


def fetch_target_health(endpoint: str, *, timeout: float = 10.0) -> dict:
    """GET the target service's /health; raise ProviderError when unreachable.

    Exists because a credit-exhausted key once let a run silently grade the
    MOCK fallback (68.3%, byte-identical to the offline run). The runner must
    know what it is grading before it grades anything.
    """
    base = endpoint.rstrip("/").removesuffix("/v1/intent")
    url = f"{base}/health"
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
        parsed = json.loads(raw)
    except (urllib.error.URLError, TimeoutError, ConnectionError,
            json.JSONDecodeError) as exc:
        raise ProviderError(f"{url}: health probe failed: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ProviderError(f"{url}: expected a JSON object, got {raw[:200]}")
    return parsed


class HTTPIntentClassifier:
    """Grades the live service: POST {endpoint}/v1/intent."""

    def __init__(self, endpoint: str, *, timeout: float = 15.0,
                 api_key: str | None = None, retries: int = 2) -> None:
        url = endpoint.rstrip("/")
        if not url.endswith("/v1/intent"):
            url = f"{url}/v1/intent"
        self.url = url
        self.timeout = timeout
        self.api_key = api_key
        self.retries = retries

    @property
    def name(self) -> str:
        return f"live service — POST {self.url}"

    def classify(self, text: str) -> tuple[dict, float]:
        body = json.dumps({"text": text}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        last_err: Exception | None = None
        for attempt in range(self.retries + 1):
            request = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
            start = time.monotonic()
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                latency = time.monotonic() - start
                parsed = json.loads(raw)
                if not isinstance(parsed, dict):
                    raise ProviderError(f"{self.url}: expected a JSON object, got {raw[:200]}")
                return parsed, latency
            except urllib.error.HTTPError as exc:
                if exc.code < 500:
                    raise ProviderError(f"{self.url}: HTTP {exc.code} — {exc.reason}") from exc
                last_err = exc
            except (urllib.error.URLError, TimeoutError, ConnectionError,
                    json.JSONDecodeError) as exc:
                last_err = exc
            if attempt < self.retries:
                time.sleep(1.0 * (attempt + 1))
        raise ProviderError(f"{self.url}: giving up after {self.retries + 1} attempts: {last_err}")
