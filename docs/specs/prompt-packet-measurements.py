#!/usr/bin/env python3
"""Reproduces every number in prompt-packet-v1.md.

The spec's recommendation rests on measured sizes and a cardinality model, not
estimates. This script regenerates all of it so the numbers can be re-derived
(or challenged) rather than taken on trust.

    pip install tiktoken
    python3 docs/specs/prompt-packet-measurements.py          # from the repo root

Tokenizer caveat: cl100k_base is a PROXY for the Qwen/Granite BPEs. English
prose lands within roughly +/-5%; Devanagari will be materially worse (more
tokens per character). Re-run against the real tokenizer once a Scholar
checkpoint is pinned -- it moves the latency budget, which is now the binding
ceiling (spec 3.2).
"""
from __future__ import annotations

import json
import sys

try:
    import tiktoken
except ImportError:
    sys.exit("pip install tiktoken")

sys.path.insert(0, "services/intelligence")
try:
    import prompts
except ImportError:
    sys.exit("run me from the repo root (I import services/intelligence/prompts.py)")

enc = tiktoken.get_encoding("cl100k_base")
tok = lambda s: len(enc.encode(s))

# Constants read from the code, not remembered. Update here if the source moves.
MAX_BODY = 8_000            # services/memory/src/scope-store.ts:22
MAX_COMPOSED = 64_000       # services/memory/src/scope-store.ts:40
MEMORY_CTX_LIMIT = 16_000   # services/intelligence/main.py:116  <- the 5.1 defect
HISTORY_MAX_CHARS = 1_200   # services/gateway/src/orchestrator/index.ts:296
ORDERS_ROW_CAP = 50         # services/gateway/src/orchestrator/index.ts:2040
LATENCY_CEILING = 16_000    # spec 3.2 -- ASSUMPTION, ~8k tok/s prefill @ 2s p95
WINDOW = 256_000            # spec 3.2 -- shortlisted Scholars are 256k-class

SNAPSHOT = {  # post-buildSnapshot shape, fixtures/btc-usdt.json + formatting
    "symbol": "BTC/USDT", "last": 61240, "lastDisplay": "61,240",
    "change12hPct": -4.18, "change12hDisplay": "−4.2%",
    "fundingRate": -0.00008, "fundingDisplay": "−0.008%",
    "spark": [63910, 63780, 63985, 63820, 63640, 63210, 62880,
              62650, 62410, 61980, 61560, 61410, 61240],
    "asOfIso": "2026-08-10T09:23:11.412Z",
    "sources": ["BINANCEUS PUBLIC", "FUNDING"],
}
SNAP_JSON = json.dumps(SNAPSHOT, separators=(",", ":"))

# Composed exactly as memory-compose.ts labels and joins the four layers.
LAYERS = [
    ("PLATFORM RULES (binding)", "fleet",
     "Hippo is embedded in a regulated exchange. Never name a specific trade. "
     "Always show the as-of time. Keep answers under 120 words unless asked."),
    ("VENUE CONTEXT", "Host",
     "Assetworks is a spot + perpetuals venue, USDT-quoted, max 50x leverage, "
     "isolated and cross margin. Fees: 0.02% maker / 0.05% taker. "
     "Withdrawals settle in 30 minutes."),
    ("USER PROFILE", "Trader",
     "Prefers Hinglish. Trades during Asia hours.\nintermediate trader · follows "
     "BTC, ETH, SOL\n- follows: BTC\n- follows: ETH\n- prefers: perps\n"
     "- typical leverage: 10x\n- answers: concise"),
    ("THIS SESSION", "session", "- follows: SOL"),
]
COMPOSED = "\n\n".join(f"[{label}]\n{body}" for label, _, body in LAYERS)

BRIEF_USER = "\n".join([
    "QUESTION: What is driving the decline in Bitcoin (BTC/USDT) price today?",
    "ANSWER LANGUAGE: en",
    f"SNAPSHOT JSON: {SNAP_JSON}",
    "This is the live BTC market snapshot (as of 2026-08-10T09:23:11.412Z). "
    "Ground every number in this data; do not invent figures.",
    prompts.BRIEF_FORMAT_INSTRUCTIONS,
])

# Realistic operator prose. Repeated 'x' compresses to ~8 ch/tok and would
# understate every cap by roughly 2x -- worth knowing if you edit this.
SEED = ("Assetworks is a spot and perpetual futures venue quoted in USDT with a "
        "maximum leverage of fifty times and both isolated and cross margin modes. "
        "Maker fees are 0.02 percent and taker fees are 0.05 percent. Withdrawals "
        "settle within thirty minutes. Always show the as-of timestamp. ")
fill = lambda n: (SEED * (n // len(SEED) + 1))[:n]


def rule(title: str) -> None:
    print(f"\n{title}\n{'=' * len(title)}")


def main() -> None:
    rule("1 - system prompts and fixed artifacts (spec 3.1)")
    for label, s in [
        ("HIPPO_SYSTEM_PROMPT_V0 (guardrail)", prompts.HIPPO_SYSTEM_PROMPT_V0),
        ("INTENT_SYSTEM_PROMPT (Scout ingress)", prompts.INTENT_SYSTEM_PROMPT),
        ("INTENT_HISTORY_SUFFIX", prompts.INTENT_HISTORY_SUFFIX),
        ("EXTRACT_SYSTEM_PROMPT (Scout egress)", prompts.EXTRACT_SYSTEM_PROMPT),
        ("MEMORY_CONTEXT_PREFIX", prompts.MEMORY_CONTEXT_PREFIX),
        ("BRIEF_FORMAT_INSTRUCTIONS (output schema)", prompts.BRIEF_FORMAT_INSTRUCTIONS),
        ("MarketSnapshot, serialized", SNAP_JSON),
        ("composed memory, realistic 4 layers", COMPOSED),
        ("history @ HISTORY_MAX_CHARS", "why is bitcoin down today " * 46),
    ]:
        print(f"  {label:44} {len(s):7,} ch  {tok(s):6,} tok")

    rule("2 - whole-call totals (spec 3.1, 3.5)")
    c1 = tok(prompts.INTENT_SYSTEM_PROMPT) + tok(prompts.INTENT_HISTORY_SUFFIX) \
        + tok("why is bitcoin down today " * 46) + tok("why is btc down today")
    c2 = tok(prompts.HIPPO_SYSTEM_PROMPT_V0) + tok(prompts.MEMORY_CONTEXT_PREFIX) \
        + tok(COMPOSED) + tok(BRIEF_USER)
    worst = tok(prompts.HIPPO_SYSTEM_PROMPT_V0) + tok(prompts.MEMORY_CONTEXT_PREFIX) \
        + tok(fill(MAX_COMPOSED)) + tok(BRIEF_USER)
    for label, n in [("Call 1 - Scout ingress", c1), ("Call 2 - Scholar", c2),
                     ("Call 2 worst case (MAX_COMPOSED)", worst)]:
        print(f"  {label:36} {n:7,} tok   {n/WINDOW*100:6.3f}% of 256k   "
              f"{n/LATENCY_CEILING*100:6.2f}% of latency budget")

    rule("3 - THE FINDING: cardinality, not size (spec 1.2, 3.4a)")
    U = 1_000
    per_trader = sum(tok(f"[{la}]\n{b}") for la, sc, b in LAYERS if sc in ("Trader", "session"))
    print(f"  per-Trader tokens in the composed block: {per_trader}"
          f"  ({per_trader/tok(COMPOSED)*100:.0f}% of it)\n")

    print("  A - free text, relevance-filtered (size optimised; WRONG variable)")
    for label, toks in [("unfiltered", per_trader), ("filtered ~30t", 30), ("filtered ~10t", 10)]:
        M = 901
        print(f"    {label:16} {toks:3d} tok   M={M:4d}   hit {(U-min(U,M))/U*100:5.1f}%")
    print("    -> the key hashes CONTENT (_memory_key = sha1). Length is not an input.\n")

    print("  B - quantized closed vocabulary (cardinality optimised; RIGHT variable)")
    axes, M, toks = [], 1, 0
    for name, size, cost in [("depth{3}", 3, 2), ("style{2}", 2, 2),
                             ("instrument{2}", 2, 2), ("leverage{3}", 3, 2),
                             ("assets{5}", 5, 2)]:
        axes.append(name); M *= size; toks += cost
        mark = "  <- SPECIFIED" if len(axes) == 3 else ""
        print(f"    {' x '.join(axes):48} {toks:3d} tok   M={M:4d}   "
              f"hit {(U-min(U,M))/U*100:5.1f}%{mark}")
    print("    -> namespaces MULTIPLY. Keep the product under 50 (spec 3.4a note 3).")

    rule("4 - defect 5.1: transport limit vs composable maximum")
    labels = sum(len(f"[{la}]\n") for la, _, _ in LAYERS) + 3 * len("\n\n")
    composable = 4 * MAX_BODY + labels
    print(f"  intelligence limit (main.py:116)      {MEMORY_CTX_LIMIT:7,} ch")
    print(f"  gateway can compose (4 x MAX_BODY)    {composable:7,} ch  + persona/fact lines")
    print(f"  store cap (scope-store.ts:40)         {MAX_COMPOSED:7,} ch")
    print(f"  -> docs totalling over {MEMORY_CTX_LIMIT - labels:,} ch produce a 422;")
    print("     the gateway catches it and every research turn silently degrades.")
    print(f"  -> STATUS: {'STILL PRESENT' if MEMORY_CTX_LIMIT < composable else 'FIXED'}")


if __name__ == "__main__":
    main()
