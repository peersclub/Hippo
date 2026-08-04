"""Intent-accuracy scoring: confusion matrix, P/R/F1, payload-field diffing.

The answer-quality harness (`scoring.py`) grades what Hippo *said*. This module
grades whether it UNDERSTOOD: one predicted intent per query against a
hand-labelled `expected_intent`, plus field-level accuracy for the structured
payloads a correct understanding must also produce (order / host action /
amend / alert).

Stdlib only, no I/O — `report.py` writes the files, `run.py` drives the
backends.
"""
from __future__ import annotations

from collections import Counter

# The nine intents the product actually routes on. `alert` is emitted by the
# alert fast path but deliberately absent from intent.py's INTENTS set (that
# set gates *LLM-proposed* intents; alerts are deterministic-only), so it is
# listed here explicitly rather than imported.
INTENTS: tuple[str, ...] = (
    "action", "advice", "alert", "concept", "host_action",
    "orders_query", "portfolio", "research", "smalltalk",
)

# Short labels for the ASCII confusion matrix (columns must stay narrow).
ABBREV: dict[str, str] = {
    "action": "act", "advice": "adv", "alert": "alrt", "concept": "cpt",
    "host_action": "host", "orders_query": "ordq", "portfolio": "pf",
    "research": "rsch", "smalltalk": "smtk",
}
UNKNOWN = "?"  # predicted something outside the taxonomy, or the backend errored

# Payload assertions a row may carry → where to find them in a prediction.
PAYLOAD_KINDS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("order", "expected_order", ("order",)),
    ("host_action", "expected_host_action", ("hostAction", "host_action")),
    ("amend", "expected_amend", ("amend",)),
    ("alert", "expected_alert", ("alertIntent", "alert")),
)

# Order fields worth asserting — the ones a wrong parse turns into a wrong trade.
ORDER_FIELDS: tuple[str, ...] = (
    "side", "size", "instrument", "orderType", "limitPrice", "leverage",
    "direction", "reduceOnly", "sizeFraction", "stopLossPrice", "takeProfitPrice",
)

# Intents on which each payload assertion is plausible. A row asserting an
# order on intent=smalltalk is a labelling bug, not a model finding.
PAYLOAD_INTENTS: dict[str, frozenset[str]] = {
    "order": frozenset({"action"}),
    "amend": frozenset({"action"}),
    "host_action": frozenset({"host_action"}),
    "alert": frozenset({"alert"}),
}


# --- value + payload normalisation -------------------------------------------
def values_equal(expected: object, got: object) -> bool:
    """Compare a labelled value to a predicted one, tolerating str/number skew.

    The classifier returns sizes and prices as wire STRINGS ("0.5", "60000")
    while a label may read more naturally as a number; both spellings mean the
    same order. Booleans stay strict — `reduceOnly: True` must not match `1`.
    """
    if isinstance(expected, bool) or isinstance(got, bool):
        return expected is got
    if expected is None or got is None:
        return expected is got
    try:
        a, b = float(expected), float(got)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return str(expected).strip().casefold() == str(got).strip().casefold()
    return abs(a - b) <= 1e-6 * max(1.0, abs(a))


def normalize_host_action(raw: object) -> dict | None:
    """Flatten a host action to {"action": str, "params": {...}}.

    The classifier spells the payload two ways — `{"action": "set_timeframe",
    "timeframe": "5m"}` and `{"action": "prefill_ticket", "params": {...}}` —
    so both sides are folded into one shape before comparison.
    """
    if not isinstance(raw, dict):
        return None
    action = raw.get("action")
    params: dict = dict(raw.get("params") or {}) if isinstance(raw.get("params"), dict) else {}
    for key, value in raw.items():
        if key not in ("action", "params"):
            params[key] = value
    return {"action": action, "params": params}


def _flatten(kind: str, payload: object) -> dict | None:
    """Payload → flat {field: value} for field-by-field comparison."""
    if kind == "host_action":
        norm = normalize_host_action(payload)
        if norm is None:
            return None
        flat: dict = {"action": norm["action"]}
        for key, value in norm["params"].items():
            flat[f"params.{key}"] = value
        return flat
    return dict(payload) if isinstance(payload, dict) else None


def compare_payload(kind: str, expected: object, predicted: object) -> dict:
    """Field-level diff of one payload.

    Only fields the LABEL asserts are graded — extra fields in the prediction
    are ignored, because the labels deliberately assert only what a correct
    parse *must* produce. Status per field: match | wrong | missing.
    """
    exp = _flatten(kind, expected) or {}
    got = _flatten(kind, predicted)
    fields: dict[str, dict] = {}
    for name, want in exp.items():
        if got is None or name not in got:
            fields[name] = {"expected": want, "got": None, "status": "missing"}
        elif values_equal(want, got[name]):
            fields[name] = {"expected": want, "got": got[name], "status": "match"}
        else:
            fields[name] = {"expected": want, "got": got[name], "status": "wrong"}
    return {
        "kind": kind,
        "payload_present": got is not None,
        "n_expected": len(fields),
        "n_match": sum(1 for f in fields.values() if f["status"] == "match"),
        "exact": bool(fields) and all(f["status"] == "match" for f in fields.values()),
        "fields": fields,
    }


# --- per-query scoring ---------------------------------------------------------
def score_intent_query(query: dict, prediction: dict | None, error: str | None = None) -> dict:
    """Grade one classification against its label."""
    expected = query.get("expected_intent")
    predicted = None
    if isinstance(prediction, dict):
        raw = prediction.get("intent")
        predicted = raw if isinstance(raw, str) and raw else None
    payloads: dict[str, dict] = {}
    for kind, label_key, pred_keys in PAYLOAD_KINDS:
        if label_key not in query:
            continue
        found = None
        for key in pred_keys:
            if isinstance(prediction, dict) and prediction.get(key) is not None:
                found = prediction[key]
                break
        payloads[kind] = compare_payload(kind, query[label_key], found)
    return {
        "id": query.get("id"),
        "lang": query.get("lang"),
        "category": query.get("category"),
        "text": query.get("text"),
        "expected_intent": expected,
        "predicted_intent": predicted,
        "correct": predicted == expected,
        "confidence": (prediction or {}).get("confidence"),
        "predicted_language": (prediction or {}).get("language"),
        "payloads": payloads,
        "error": error,
    }


# --- aggregation ----------------------------------------------------------------
def _accuracy(rows: list[dict]) -> dict:
    n = len(rows)
    hits = sum(1 for r in rows if r["correct"])
    return {"n": n, "correct": hits, "accuracy": (hits / n) if n else None}


def confusion_matrix(rows: list[dict]) -> dict[str, dict[str, int]]:
    """{expected: {predicted: count}} over every label seen, plus '?' misses."""
    labels = sorted({r["expected_intent"] for r in rows if r["expected_intent"]})
    matrix = {e: Counter() for e in labels}
    for row in rows:
        exp = row["expected_intent"]
        if exp is None:
            continue
        got = row["predicted_intent"]
        matrix[exp][got if got in INTENTS else UNKNOWN] += 1
    return {e: dict(c) for e, c in matrix.items()}


def per_intent_metrics(rows: list[dict]) -> dict[str, dict]:
    """Precision / recall / F1 / support per intent. Zero denominators → None."""
    out: dict[str, dict] = {}
    for intent in INTENTS:
        tp = sum(1 for r in rows if r["expected_intent"] == intent and r["predicted_intent"] == intent)
        fp = sum(1 for r in rows if r["expected_intent"] != intent and r["predicted_intent"] == intent)
        fn = sum(1 for r in rows if r["expected_intent"] == intent and r["predicted_intent"] != intent)
        support = tp + fn
        precision = tp / (tp + fp) if (tp + fp) else None
        recall = tp / support if support else None
        if precision and recall:
            f1 = 2 * precision * recall / (precision + recall)
        else:
            f1 = 0.0 if support or (tp + fp) else None
        out[intent] = {"support": support, "tp": tp, "fp": fp, "fn": fn,
                       "precision": precision, "recall": recall, "f1": f1}
    return out


def payload_field_stats(rows: list[dict]) -> dict[str, dict]:
    """Field-level roll-up per payload kind: match / wrong / missing counts."""
    stats: dict[str, dict] = {}
    for row in rows:
        for kind, result in row["payloads"].items():
            bucket = stats.setdefault(kind, {
                "rows": 0, "exact_rows": 0, "payload_missing_rows": 0,
                "fields": {}, "totals": {"match": 0, "wrong": 0, "missing": 0},
            })
            bucket["rows"] += 1
            bucket["exact_rows"] += 1 if result["exact"] else 0
            bucket["payload_missing_rows"] += 0 if result["payload_present"] else 1
            for name, field in result["fields"].items():
                fb = bucket["fields"].setdefault(name, {"match": 0, "wrong": 0, "missing": 0})
                fb[field["status"]] += 1
                bucket["totals"][field["status"]] += 1
    for bucket in stats.values():
        total = sum(bucket["totals"].values())
        bucket["field_accuracy"] = (bucket["totals"]["match"] / total) if total else None
        bucket["exact_rate"] = bucket["exact_rows"] / bucket["rows"] if bucket["rows"] else None
    return stats


def worst_confusions(rows: list[dict], top: int = 8, examples: int = 3) -> list[dict]:
    """The most frequent expected→predicted mistakes, with example texts."""
    buckets: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        if row["correct"] or not row["expected_intent"]:
            continue
        key = (row["expected_intent"], row["predicted_intent"] or UNKNOWN)
        buckets.setdefault(key, []).append(row)
    ranked = sorted(buckets.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    return [
        {
            "expected": exp, "got": got, "count": len(rs),
            "examples": [{"id": r["id"], "lang": r["lang"], "text": r["text"]}
                         for r in rs[:examples]],
        }
        for (exp, got), rs in ranked[:top]
    ]


def _group(rows: list[dict], key: str) -> dict[str, dict]:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        groups.setdefault(row.get(key) or "unknown", []).append(row)
    return {name: _accuracy(rs) for name, rs in sorted(groups.items())}


def aggregate_intent(rows: list[dict]) -> dict:
    """Full summary: overall, confusion, P/R/F1, per-lang, per-category, payloads."""
    overall = _accuracy(rows)
    return {
        "n": len(rows),
        "overall": overall,
        "accuracy": overall["accuracy"],
        "confusion": confusion_matrix(rows),
        "per_intent": per_intent_metrics(rows),
        "per_lang": _group(rows, "lang"),
        "per_category": _group(rows, "category"),
        "payloads": payload_field_stats(rows),
        "worst_confusions": worst_confusions(rows),
        "errors": sum(1 for r in rows if r.get("error")),
        "unparsed": sum(1 for r in rows if r["predicted_intent"] is None),
    }


# --- rendering -------------------------------------------------------------------
def _pct(x: float | None, nd: int = 1) -> str:
    return "n/a" if x is None else f"{x * 100:.{nd}f}%"


def render_confusion_matrix(confusion: dict[str, dict[str, int]]) -> str:
    """ASCII confusion matrix, rows = expected, columns = predicted."""
    predicted_seen = {p for counts in confusion.values() for p in counts}
    cols = [i for i in INTENTS if i in predicted_seen or i in confusion]
    if UNKNOWN in predicted_seen:
        cols.append(UNKNOWN)
    rows = [i for i in INTENTS if i in confusion]
    label_w = max([len("expected \\ pred")] + [len(r) for r in rows])
    heads = [ABBREV.get(c, c) for c in cols]
    cell_w = max(4, max((len(h) for h in heads), default=4))

    lines = ["expected \\ pred".ljust(label_w) + "".join(h.rjust(cell_w + 1) for h in heads)
             + "total".rjust(cell_w + 2)]
    for expected in rows:
        counts = confusion[expected]
        total = sum(counts.values())
        cells = []
        for col in cols:
            n = counts.get(col, 0)
            # A dot for a clean zero keeps the diagonal readable at a glance.
            cells.append(("." if n == 0 else str(n)).rjust(cell_w + 1))
        lines.append(expected.ljust(label_w) + "".join(cells) + str(total).rjust(cell_w + 2))
    return "\n".join(lines)


def _accuracy_table(title: str, groups: dict[str, dict]) -> list[str]:
    lines = [f"## {title}", "", "| group | n | correct | accuracy |", "|---|---|---|---|"]
    for name, agg in groups.items():
        lines.append(f"| {name} | {agg['n']} | {agg['correct']} | {_pct(agg['accuracy'])} |")
    lines.append("")
    return lines


def render_intent_summary_md(
    summary: dict,
    *,
    backend: str,
    queries_path: str,
    timestamp: str,
    fail_under: float | None,
) -> str:
    acc = summary["accuracy"]
    lines = [
        "# Hippo intent-accuracy scorecard",
        "",
        f"- **Run:** {timestamp} (UTC)",
        f"- **Backend:** {backend}",
        f"- **Queries:** {summary['n']} from `{queries_path}`",
        f"- **Overall intent accuracy:** **{_pct(acc)}** "
        f"({summary['overall']['correct']}/{summary['n']})",
        f"- **Backend errors:** {summary['errors']} · unparsed predictions: {summary['unparsed']}",
    ]
    if fail_under is not None:
        verdict = "PASS" if (acc is not None and acc >= fail_under) else "FAIL"
        lines.append(f"- **Gate:** {verdict} — accuracy {_pct(acc)} vs --fail-under {_pct(fail_under)}")
    lines += ["", "## Confusion matrix (rows = expected, columns = predicted)", "", "```",
              render_confusion_matrix(summary["confusion"]), "```", ""]

    lines += ["## Per-intent precision / recall / F1", "",
              "| intent | support | TP | FP | FN | precision | recall | F1 |",
              "|---|---|---|---|---|---|---|---|"]
    for intent, m in summary["per_intent"].items():
        if not m["support"] and not m["fp"]:
            continue  # intent absent from this set and never predicted
        f1 = "n/a" if m["f1"] is None else f"{m['f1']:.3f}"
        lines.append(
            f"| {intent} | {m['support']} | {m['tp']} | {m['fp']} | {m['fn']} "
            f"| {_pct(m['precision'])} | {_pct(m['recall'])} | {f1} |"
        )
    lines.append("")

    lines += _accuracy_table("Per language", summary["per_lang"])
    lines += _accuracy_table("Per category", summary["per_category"])

    payloads = summary["payloads"]
    if payloads:
        lines += ["## Payload-parameter accuracy", ""]
        for kind in sorted(payloads):
            bucket = payloads[kind]
            lines += [
                f"### `{kind}` — {bucket['rows']} labelled rows",
                "",
                f"- exact payload match: {bucket['exact_rows']}/{bucket['rows']} "
                f"({_pct(bucket['exact_rate'])})",
                f"- payload entirely absent from the prediction: "
                f"{bucket['payload_missing_rows']}/{bucket['rows']}",
                f"- field-level accuracy: {_pct(bucket['field_accuracy'])} "
                f"({bucket['totals']['match']} right, {bucket['totals']['wrong']} wrong, "
                f"{bucket['totals']['missing']} missing)",
                "",
                "| field | asserted | right | wrong | missing |",
                "|---|---|---|---|---|",
            ]
            for name in sorted(bucket["fields"]):
                fb = bucket["fields"][name]
                asserted = fb["match"] + fb["wrong"] + fb["missing"]
                lines.append(f"| {name} | {asserted} | {fb['match']} | {fb['wrong']} | {fb['missing']} |")
            lines.append("")

    lines += ["## Worst confusions", ""]
    if not summary["worst_confusions"]:
        lines.append("None — every query was classified correctly.")
    for entry in summary["worst_confusions"]:
        lines.append(f"- **{entry['count']}× expected={entry['expected']} got={entry['got']}**")
        for ex in entry["examples"]:
            lines.append(f"  - `{ex['id']}` ({ex['lang']}) {ex['text']}")
    lines.append("")
    return "\n".join(lines) + "\n"


def format_worst_confusions(summary: dict, top: int = 5) -> list[str]:
    """Console lines for the worst confusions — the "what to fix" list."""
    out: list[str] = []
    for entry in summary["worst_confusions"][:top]:
        out.append(f"  {entry['count']}x expected={entry['expected']} got={entry['got']}")
        for ex in entry["examples"][:2]:
            out.append(f"      e.g. [{ex['lang']}] {ex['text']}")
    return out
