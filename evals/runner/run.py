#!/usr/bin/env python3
"""Hippo eval runner — bake-off harness. Stdlib only.

Two modes:

  --mode answer (default)  grade what Hippo SAID: 300-query answer-quality exam.
  --mode intent            grade whether Hippo UNDERSTOOD: intent accuracy,
                           confusion matrix, and order/host-action parameters.

Usage (vLLM candidate + same endpoint as judge):
    python3 evals/runner/run.py --endpoint http://localhost:8000/v1 --model Qwen/Qwen3-32B

Offline (CI) mode:
    python3 evals/runner/run.py --mock --limit 20
    python3 evals/runner/run.py --mode intent            # offline rule_classify
    python3 evals/runner/run.py --mode intent --intent-endpoint http://localhost:8781

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
from evals.runner.intent_backends import (
    HTTPIntentClassifier,
    OfflineRuleClassifier,
    fetch_target_health,
)
from evals.runner.intent_scoring import format_worst_confusions, score_intent_query
from evals.runner.providers import (
    HTTPChatProvider,
    MockCandidateProvider,
    MockJudgeProvider,
    ProviderError,
)
from evals.runner.report import write_intent_report, write_report
from evals.runner.scoring import parse_judge_json, score_query

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_QUERIES = REPO_ROOT / "evals" / "queries" / "v1.jsonl"
DEFAULT_INTENT_QUERIES = REPO_ROOT / "evals" / "queries" / "v1-intents.jsonl"
DEFAULT_OUT = REPO_ROOT / "evals" / "reports"
INTELLIGENCE_DIR = REPO_ROOT / "services" / "intelligence"


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
    p.add_argument("--mode", choices=("answer", "intent"), default="answer",
                   help="answer: grade the reply (default). intent: grade the classification.")
    p.add_argument("--queries", default=None,
                   help=f"query set JSONL (default: {DEFAULT_QUERIES.name} for --mode answer, "
                        f"{DEFAULT_INTENT_QUERIES.name} for --mode intent)")
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
    intent = p.add_argument_group("--mode intent")
    intent.add_argument("--intent-endpoint",
                        help="base URL of a running intelligence service (POST /v1/intent). "
                             "Omit to grade rule_classify offline, with no server and no LLM.")
    intent.add_argument("--intent-service-dir", default=str(INTELLIGENCE_DIR),
                        help="path to services/intelligence for the offline backend")
    intent.add_argument("--fail-under", type=float,
                        help="exit nonzero when overall intent accuracy falls below this "
                             "fraction (e.g. 0.85) — the CI gate")
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


def check_target_health(endpoint: str, timeout: float) -> dict | None:
    """Probe {endpoint}/health before grading; refuse a degraded backend.

    Returns the provider stamp for the report header, or None (after printing
    a loud refusal) when the target is not serving live LLM answers. A run
    against the mock fallback produces scores byte-identical to the offline
    run — grading it and printing a percentage would be a lie about the model.
    """
    try:
        health = fetch_target_health(endpoint, timeout=min(timeout, 10.0))
    except ProviderError as exc:
        print(f"error: cannot verify the target backend — {exc}", file=sys.stderr)
        return None
    llm = health.get("llm")
    provider = {
        "providerMode": health.get("providerMode") or llm or "unknown",
        "model": health.get("model") or "unknown",
        "sha": health.get("sha") or "unknown",
    }
    if llm != "live":
        print(
            "\n" + "=" * 72 + "\n"
            "REFUSING TO GRADE: the target backend is NOT serving live LLM "
            f"answers.\n  /health reports llm={llm!r} model={provider['model']!r} "
            f"sha={provider['sha']!r}\n"
            "  Scores from this state grade the deterministic mock fallback, "
            "not a model.\n  Fix the provider (key/credits/endpoint) and rerun."
            "\n" + "=" * 72,
            file=sys.stderr,
        )
        return None
    return provider


def run_intent_mode(args: argparse.Namespace, queries: list[dict], queries_path: str) -> int:
    """Classify every query, score against expected_intent, write the scorecard."""
    unlabeled = [q["id"] for q in queries if not q.get("expected_intent")]
    if unlabeled:
        print(f"error: {len(unlabeled)} row(s) have no expected_intent "
              f"(first: {unlabeled[0]}) — label the set before grading it", file=sys.stderr)
        return 2

    provider: dict | None = None
    if args.intent_endpoint:
        provider = check_target_health(args.intent_endpoint, args.timeout)
        if provider is None:
            return 2

    try:
        if args.intent_endpoint:
            backend: HTTPIntentClassifier | OfflineRuleClassifier = HTTPIntentClassifier(
                args.intent_endpoint, timeout=args.timeout, api_key=args.api_key,
            )
        else:
            backend = OfflineRuleClassifier(Path(args.intent_service_dir))
    except ProviderError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"Classifying {len(queries)} queries via {backend.name} ...")
    results: list[dict] = []
    for i, query in enumerate(queries, 1):
        prediction: dict | None = None
        error: str | None = None
        latency = 0.0
        try:
            prediction, latency = backend.classify(query["text"])
        except ProviderError as exc:
            error = str(exc)
        row = score_intent_query(query, prediction, error)
        row["latency_s"] = round(latency, 5)
        results.append(row)
        if i % 50 == 0 or i == len(queries):
            print(f"  {i}/{len(queries)} done")

    report_dir, summary = write_intent_report(
        Path(args.out), results, backend=backend.name,
        queries_path=queries_path, fail_under=args.fail_under,
        provider=provider,
    )
    accuracy = summary["accuracy"] or 0.0
    print(f"\nReport: {report_dir}/intent-summary.md")
    if provider:
        print(f"  target: providerMode={provider['providerMode']} "
              f"model={provider['model']} sha={provider['sha']}")
    print(f"  overall intent accuracy: {accuracy:.1%} "
          f"({summary['overall']['correct']}/{summary['n']})")
    for lang, agg in summary["per_lang"].items():
        print(f"    {lang:9s} {agg['accuracy']:.1%} ({agg['correct']}/{agg['n']})")
    if summary["worst_confusions"]:
        print("  worst confusions:")
        for line in format_worst_confusions(summary):
            print(line)
    if args.fail_under is not None:
        ok = accuracy >= args.fail_under
        print(f"\n  [{'PASS' if ok else 'FAIL'}] accuracy {accuracy:.1%} "
              f"vs --fail-under {args.fail_under:.1%}")
        if not ok:
            return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    queries_path = args.queries or str(
        DEFAULT_INTENT_QUERIES if args.mode == "intent" else DEFAULT_QUERIES
    )
    if args.mode == "answer" and not args.mock and not (args.endpoint and args.model):
        print("error: provide --endpoint and --model, or use --mock", file=sys.stderr)
        return 2

    queries = load_queries(Path(queries_path), args.limit)
    if not queries:
        print(f"error: no queries loaded from {queries_path}", file=sys.stderr)
        return 2

    if args.mode == "intent":
        return run_intent_mode(args, queries, queries_path)

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
        Path(args.out), results, model=model_name, queries_path=queries_path,
        mode=mode, baseline_path=args.baseline,
    )
    print(f"\nReport: {report_dir}/summary.md")
    for name, verdict, detail in verdicts:
        print(f"  [{verdict}] {name} — {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
