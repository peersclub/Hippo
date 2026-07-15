"""Client for services/market-data + symbol extraction.

GET {MARKET_DATA_URL}/v1/snapshot?symbol=BTC/USDT →
{last, lastDisplay, change12hPct, change12hDisplay, fundingRate,
 fundingDisplay, spark, asOfIso, sources}
"""
from __future__ import annotations

import os
import re

import httpx

MARKET_DATA_URL = os.environ.get("MARKET_DATA_URL", "http://localhost:8790")

# Instrument resolution is keyword-based for the pilot set; it becomes
# catalog-driven (the venue's listed-instruments feed) later.
_ASSET_WORDS: dict[str, str] = {
    "btc": "BTC", "bitcoin": "BTC", "बिटकॉइन": "BTC",
    "eth": "ETH", "ethereum": "ETH", "ether": "ETH",
    "sol": "SOL", "solana": "SOL",
    "ada": "ADA", "cardano": "ADA",
    "matic": "MATIC", "polygon": "MATIC",
    "doge": "DOGE", "dogecoin": "DOGE",
    "xrp": "XRP", "ripple": "XRP",
}

_WORD_RE = re.compile(r"[a-zA-Zऀ-ॿ]+")


def normalize_asset(token: str) -> str | None:
    """"btc"/"bitcoin" → "BTC"; None when unrecognized."""
    return _ASSET_WORDS.get(token.lower())


def to_pair(asset: str) -> str:
    """"BTC" → "BTC/USDT". USDT-quoted spot is the pilot universe."""
    return f"{asset.upper()}/USDT"


def extract_symbol(text: str, default: str = "BTC") -> str:
    """First recognized asset mention in the text, else the default (BTC)."""
    for token in _WORD_RE.findall(text):
        asset = normalize_asset(token)
        if asset:
            return asset
    return default


async def fetch_snapshot(symbol: str, timeout: float = 3.0) -> dict | None:
    """Fetch the live snapshot for an asset ("BTC") or pair ("BTC/USDT").

    Returns None on any failure — callers degrade to concept-mode rather
    than surface an error (the model never invents numbers to fill the gap).
    """
    pair = symbol if "/" in symbol else to_pair(symbol)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(
                f"{MARKET_DATA_URL}/v1/snapshot", params={"symbol": pair}
            )
            res.raise_for_status()
            data = res.json()
    except (httpx.HTTPError, OSError, ValueError):
        return None
    if not isinstance(data, dict) or "last" not in data:
        return None
    return data
