#!/usr/bin/env python3
"""Hippo eval runner — 300-query bake-off harness. Stdlib only.

Usage (vLLM candidate + same endpoint as judge):
    python3 evals/runner/run.py --endpoint http://localhost:8000/v1 --model Qwen/Qwen3-32B

Offline (CI) mode:
    python3 evals/runner/run.py --mock --limit 20

Also runnable as a module: python3 -m evals.runner.run
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):  # direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evals.runner import prompts
from evals.runner.providers import (
    HTTPChatProvider,
    MockCandidateProvider,
    MockJudgeProvider,
    ProviderError,
)
from evals.runner.report import write_report
from evals.runner.scoring import parse_judge_json, score_query

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_QUERIES = REPO_ROOT / "evals" / "queries" / "v1.jsonl"
DEFAULT_OUT = REPO_ROOT / "evals" / "reports"


def load_queries(path: Path, limit: int | None) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows[:limit] if limit else rows


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--queries", default=str(DEFAULT_QUERIES), help="query set JSONL")
    p.add_argument("--endpoint", help="OpenAI-compatible base URL for the candidate (e.g. http://localhost:8000/v1)")
    p.add_argument("--model", help="candidate model name as served by the endpoint")
    p.add_argument("--judge-endpoint", help="judge base URL (default: --endpoint)")
    p.add_argument("--judge-model", help="judge model name (default: --model)")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="reports output directory")
    p.add_argument("--limit", type=int, help="run only the first N queries")
    p.add_argument("--mock", action="store_true", help="offline deterministic mock candidate + judge (CI)")
    p.add_argument("--mock-quality", choices=("good", "mixed", "bad"), default="mixed",
                   help="mock answer quality profile (default: mixed, ~1 in 8 bad)")
    p.add_argument("--baseline", help="previous run's results.jsonl (or report dir) to diff the 5%% gates against")
    p.add_argument("--max-tokens", type=int, default=1024)
    p.add_argument("--timeout", type=float, default=120.0)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--api-key", help="bearer token if the endpoint requires one")
    return p


def run_one(
    query: dict,
    candidate: MockCandidateProvider | HTTPChatProvider,
    judge: MockJudgeProvider | HTTPChatProvider,
) -> dict:
    """Answer + judge + score a single query. Never raises; errors are recorded."""
    answer, latency = "", 0.0
    error: str | None = None
    try:
        if isinstance(candidate, MockCandidateProvider):
            answer, latency = candidate.answer(query)
        else:
            answer, latency = candidate.chat(prompts.build_candidate_messages(query))
    except ProviderError as exc:
        error = f"candidate: {exc}"

    judge_quality: dict | None = None
    judge_advice: dict | None = None
    if not error:
        if isinstance(judge, MockJudgeProvider):
            judge_quality = judge.judge_quality(query, answer)
            judge_advice = judge.judge_advice(query, answer)
        else:
            try:
                raw_q, _ = judge.chat(prompts.build_quality_judge_messages(query, answer), json_mode=True)
                judge_quality = parse_judge_json(raw_q)
                raw_a, _ = judge.chat(prompts.build_advice_judge_messages(query, answer), json_mode=True)
                judge_advice = parse_judge_json(raw_a)
            except ProviderError as exc:
                error = f"judge: {exc}"  # deterministic layer still scores below

    scored = score_query(query, answer, latency, judge_quality, judge_advice)
    return {
        "id": query["id"],
        "lang": query.get("lang"),
        "category": query.get("category"),
        "text": query.get("text"),
        "expected_behavior": query.get("expected_behavior"),
        "response": answer,
        "latency_s": round(latency, 4),
        "error": error,
        **scored,
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.mock and not (args.endpoint and args.model):
        print("error: provide --endpoint and --model, or use --mock", file=sys.stderr)
        return 2

    queries = load_queries(Path(args.queries), args.limit)
    if not queries:
        print(f"error: no queries loaded from {args.queries}", file=sys.stderr)
        return 2

    if args.mock:
        candidate: MockCandidateProvider | HTTPChatProvider = MockCandidateProvider(args.mock_quality)
        judge: MockJudgeProvider | HTTPChatProvider = MockJudgeProvider()
        model_name = f"mock-{args.mock_quality}"
        mode = f"mock ({args.mock_quality})"
    else:
        candidate = HTTPChatProvider(
            args.endpoint, args.model, timeout=args.timeout,
            max_tokens=args.max_tokens, temperature=args.temperature, api_key=args.api_key,
        )
        judge = HTTPChatProvider(
            args.judge_endpoint or args.endpoint, args.judge_model or args.model,
            timeout=args.timeout, max_tokens=512, temperature=0.0, api_key=args.api_key,
        )
        model_name = args.model
        mode = "live"

    print(f"Running {len(queries)} queries against {model_name} ({mode}) ...")
    results: list[dict] = []
    for i, query in enumerate(queries, 1):
        row = run_one(query, candidate, judge)
        results.append(row)
        if i % 25 == 0 or i == len(queries):
            print(f"  {i}/{len(queries)} done")

    report_dir, _summary, verdicts = write_report(
        Path(args.out), results, model=model_name, queries_path=args.queries,
        mode=mode, baseline_path=args.baseline,
    )
    print(f"\nReport: {report_dir}/summary.md")
    for name, verdict, detail in verdicts:
        print(f"  [{verdict}] {name} — {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
