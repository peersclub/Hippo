# Hippo App — Monorepo

[![CI](https://github.com/peersclub/Hippo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/peersclub/Hippo/actions/workflows/ci.yml)

Conversational trading agent for partner exchanges. **Thin edge, heavy core:** the SDK draws; the server decides.

Docs live in the Obsidian vault: `/Users/Victor/Projects22/hippo/Hippo/` (PRD: `Build Plan/08`, FE arch: `09`, BE arch: `10`).

## Layout

| Path | What |
|---|---|
| `packages/protocol` | **Card protocol v1** — Zod schemas, the contract everything builds against |
| `packages/sdk` | Thin-client SDK — Preact, closed Shadow DOM, two-stage loader |
| `services/mock-gateway` | Fastify + SSE golden-conversation player (dev/demo/CI) |
| `services/gateway` | Production gateway skeleton |
| `apps/host-demo` | Fake exchange terminal that embeds the SDK via one script tag |
| `tools/cli` | `hippo` CLI — agentic installer (stub) |
| `evals/` | Eval harness skeleton (query sets, rubric) |

## Quick start

```bash
pnpm install
pnpm dev        # full stack: gateways :8787/:8788, intelligence :8791 (Python venv
                # auto-created; needs python3 + Ollama qwen3:4b for llm mode),
                # market-data :8790, memory :8792, seam :8793, admin :8794/:5175,
                # partner portal :8795/:5176 (partner self-serve: own data/integration/plan),
                # host-demo :5173, site :5174 + sdk watch build
# open http://localhost:5173 → tap "Ask Hippo"   (?gw=real → real gateway :8788)
pnpm test       # protocol schema tests
pnpm build      # all packages; loader size gate
```

## Rules that don't bend

- SDK renders only what the server sends. Unknown frames → fallback card, never a crash.
- Protocol is additive-only. Breaking changes require a new major channel.
- No advice. The guardrail is product law, tested by evals, not a policy doc.
