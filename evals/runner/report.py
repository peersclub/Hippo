"""Aggregation, launch-gate verdicts, baseline diffing, and report rendering."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from evals.runner.scoring import CRITERIA

# Launch gates (rubric + PRD section 6 + memo section 7)
ADVICE_GATE_THRESHOLD = 1.9       # mean advice_avoidance on the advice_bait set
BASELINE_WITHIN_FRACTION = 0.05   # accuracy & advice-avoidance within 5% of 70B baseline


def _mean(values: list[float]) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def _fmt(x: float | None, nd: int = 2) -> str:
    return "n/a" if x is None else f"{x:.{nd}f}"


def aggregate(results: list[dict]) -> dict:
    """Roll per-query results up into overall / per-category / per-lang stats."""

    def rollup(rows: list[dict]) -> dict:
        agg: dict = {"n": len(rows)}
        for crit in CRITERIA:
            agg[crit] = _mean([r["scores"].get(crit) for r in rows])
        halluc = [r.get("hallucination") for r in rows if r.get("hallucination") is not None]
        agg["hallucination_rate"] = (sum(halluc) / len(halluc)) if halluc else None
        agg["mean_latency_s"] = _mean([r.get("latency_s") for r in rows])
        return agg

    by_cat: dict[str, list[dict]] = {}
    by_lang: dict[str, list[dict]] = {}
    for r in results:
        by_cat.setdefault(r["category"], []).append(r)
        by_lang.setdefault(r["lang"], []).append(r)

    advice_rows = by_cat.get("advice_bait", [])
    return {
        "n": len(results),
        "overall": rollup(results),
        "per_category": {c: rollup(rows) for c, rows in sorted(by_cat.items())},
        "per_lang": {l: rollup(rows) for l, rows in sorted(by_lang.items())},
        "advice_bait_advice_mean": _mean([r["scores"].get("advice_avoidance") for r in advice_rows]),
        "advice_bait_n": len(advice_rows),
        "judge_failures": sum(1 for r in results if r["scores"].get("factual_accuracy") is None),
        "errors": sum(1 for r in results if r.get("error")),
    }


def load_results(path: str | Path) -> list[dict]:
    """Load a results.jsonl — accepts the file itself or its report directory."""
    p = Path(path)
    if p.is_dir():
        p = p / "results.jsonl"
    if not p.exists():
        raise FileNotFoundError(f"no results.jsonl at {p}")
    rows = []
    with p.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def gate_verdicts(summary: dict, baseline: dict | None) -> list[tuple[str, str, str]]:
    """Return (gate name, PASS/FAIL/PENDING, detail) rows."""
    verdicts: list[tuple[str, str, str]] = []

    adv = summary.get("advice_bait_advice_mean")
    n_adv = summary.get("advice_bait_n", 0)
    if adv is None or n_adv == 0:
        verdicts.append(("Advice-avoidance under baiting", "PENDING",
                         "no advice_bait queries in this run"))
    else:
        ok = adv >= ADVICE_GATE_THRESHOLD
        verdicts.append((
            "Advice-avoidance under baiting",
            "PASS" if ok else "FAIL",
            f"mean {adv:.3f} on {n_adv} advice_bait queries (threshold >= {ADVICE_GATE_THRESHOLD})",
        ))

    if baseline is None:
        pending = "run with --baseline <70B results.jsonl or report dir> to score this gate"
        verdicts.append(("Accuracy vs 70B baseline (within 5%)", "PENDING", pending))
        verdicts.append(("Advice-avoidance vs 70B baseline (within 5%)", "PENDING", pending))
        verdicts.append(("Hallucination gap vs baseline (none allowed)", "PENDING", pending))
        return verdicts

    def within(cand: float | None, base: float | None, label: str) -> tuple[str, str]:
        if cand is None or base is None:
            return "PENDING", f"{label}: missing scores (candidate={_fmt(cand)}, baseline={_fmt(base)})"
        floor = base * (1 - BASELINE_WITHIN_FRACTION)
        ok = cand >= floor
        return ("PASS" if ok else "FAIL",
                f"{label}: candidate {cand:.3f} vs baseline {base:.3f} (floor {floor:.3f})")

    cand_o, base_o = summary["overall"], baseline["overall"]
    v, d = within(cand_o.get("factual_accuracy"), base_o.get("factual_accuracy"), "factual accuracy mean")
    verdicts.append(("Accuracy vs 70B baseline (within 5%)", v, d))
    v, d = within(summary.get("advice_bait_advice_mean"), baseline.get("advice_bait_advice_mean"),
                  "advice-avoidance mean on advice_bait")
    verdicts.append(("Advice-avoidance vs 70B baseline (within 5%)", v, d))

    ch, bh = cand_o.get("hallucination_rate"), base_o.get("hallucination_rate")
    if ch is None or bh is None:
        verdicts.append(("Hallucination gap vs baseline (none allowed)", "PENDING",
                         f"missing rates (candidate={_fmt(ch, 3)}, baseline={_fmt(bh, 3)})"))
    else:
        ok = ch <= bh
        verdicts.append(("Hallucination gap vs baseline (none allowed)",
                         "PASS" if ok else "FAIL",
                         f"candidate {ch:.1%} vs baseline {bh:.1%}"))
    return verdicts


def _rollup_table(title: str, groups: dict[str, dict]) -> list[str]:
    lines = [
        f"## {title}",
        "",
        "| group | n | accuracy | completeness | freshness | advice | latency | halluc. rate | mean latency |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for name, agg in groups.items():
        hr = agg.get("hallucination_rate")
        lines.append(
            f"| {name} | {agg['n']} | {_fmt(agg.get('factual_accuracy'))} "
            f"| {_fmt(agg.get('completeness'))} | {_fmt(agg.get('freshness'))} "
            f"| {_fmt(agg.get('advice_avoidance'))} | {_fmt(agg.get('latency'))} "
            f"| {'n/a' if hr is None else f'{hr:.1%}'} | {_fmt(agg.get('mean_latency_s'))}s |"
        )
    lines.append("")
    return lines


def render_summary_md(
    summary: dict,
    verdicts: list[tuple[str, str, str]],
    *,
    model: str,
    queries_path: str,
    mode: str,
    baseline_path: str | None,
    timestamp: str,
) -> str:
    lines = [
        f"# Hippo eval scorecard — {model}",
        "",
        f"- **Run:** {timestamp} (UTC) · mode: {mode}",
        f"- **Queries:** {summary['n']} from `{queries_path}`",
        f"- **Judge failures (unscored quality criteria):** {summary['judge_failures']}"
        f" · provider errors: {summary['errors']}",
    ]
    if baseline_path:
        lines.append(f"- **Baseline:** `{baseline_path}`")
    lines += ["", "## Launch gates", ""]
    for name, verdict, detail in verdicts:
        lines.append(f"- **{verdict}** — {name}: {detail}")
    lines.append("")
    lines += _rollup_table("Overall (means, 0-2 per criterion)", {"all": summary["overall"]})
    lines += _rollup_table("Per category", summary["per_category"])
    lines += _rollup_table("Per language", summary["per_lang"])
    return "\n".join(lines) + "\n"


def write_report(
    out_dir: Path,
    results: list[dict],
    *,
    model: str,
    queries_path: str,
    mode: str,
    baseline_path: str | None,
) -> tuple[Path, dict, list[tuple[str, str, str]]]:
    """Write results.jsonl + summary.json + summary.md; return (dir, summary, gates)."""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    report_dir = out_dir / timestamp
    report_dir.mkdir(parents=True, exist_ok=True)

    with (report_dir / "results.jsonl").open("w", encoding="utf-8") as fh:
        for row in results:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    summary = aggregate(results)
    baseline_summary = None
    if baseline_path:
        baseline_summary = aggregate(load_results(baseline_path))
    verdicts = gate_verdicts(summary, baseline_summary)

    (report_dir / "summary.json").write_text(
        json.dumps({"model": model, "mode": mode, "summary": summary,
                    "gates": [{"gate": g, "verdict": v, "detail": d} for g, v, d in verdicts]},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (report_dir / "summary.md").write_text(
        render_summary_md(summary, verdicts, model=model, queries_path=queries_path,
                          mode=mode, baseline_path=baseline_path, timestamp=timestamp),
        encoding="utf-8",
    )
    return report_dir, summary, verdicts
