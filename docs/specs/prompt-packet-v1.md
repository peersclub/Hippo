# Prompt Packet — v1 spec

**Status:** Draft for implementation · 2026-08-10
**Audience:** Suresh (packet-builder implementation) · Victor (schema authority) · Sudha (threading design owner)
**Grounded in:** `main @ 2649b37` + branch `claude/hippo-codebase-review-zitelh`
**Locked before this doc, not re-litigated:** five input fields + one output field · JSON · two-call flow (Scout → Scholar) · Scout runs twice (ingress + egress) · threading = compress-forward.

---

## 0 · What this is grounded in

Every field below is traced to code that exists. Files read in full:

| Area | Files |
|---|---|
| Memory model | `packages/stores/migrations/{004,009,010,011,012}*.sql` · `services/memory/src/scope-store.ts` · `services/gateway/src/orchestrator/memory-compose.ts` · `services/gateway/src/orchestrator/memory.ts` |
| Prompt assembly | `services/intelligence/prompts.py` · `research.py` · `cache.py` · `main.py` |
| Turn orchestration | `services/gateway/src/orchestrator/index.ts` (history: 290–354; memory compose + respond: 2100–2360) · `clarify.ts` · `intelligence.ts` |
| Host data | `services/gateway/src/orchestrator/seam.ts` · `packages/stores/src/types.ts` |
| External data | `services/market-data/src/snapshot.ts` · `fixtures/btc-usdt.json` |
| Output contract | `packages/protocol/src/frames.ts` |
| Design intent | `docs/vault/Cache for Sudha.md` · `docs/vault/Build Plan/{01,03,08}` |

**There is no existing packet-builder.** `grep -riE "packet|scout|scholar"` across `services/`, `packages/`, `tools/`, `evals/` returns nothing. The closest thing that exists is `RespondRequest` (`services/intelligence/main.py:106-116`) — a five-field object that is already a proto-packet. This spec extends that, it does not replace it.

All token counts below are **measured** with `tiktoken/cl100k_base`, not estimated. Caveat: cl100k is a proxy for the Qwen/Granite BPEs. English prose typically lands within ±5%; Devanagari will be materially worse (more tokens per character). Apply a 1.15× safety factor to any Hindi-path budget until the exam measures the real tokenizer.

---

## 1 · Headline findings — read these before Part 2

### 1.1 The 1M ceiling is not the binding constraint. It is not close.

Measured, as the system actually assembles a research turn today:

| Call | Input tokens | % of 1M ceiling |
|---|---:|---:|
| Call 1 — Scout ingress (`POST /v1/intent`) | **2,158** | 0.216% |
| Call 2 — Scholar (`POST /v1/respond/stream`) | **883** | 0.088% |
| Call 2, absolute worst case (memory clamped to `MAX_COMPOSED`) | 13,727 | 1.373% |

**99.91% of the stated ceiling is unused.** A threading mechanism designed to "fit within 1M" is solving a problem the system does not have. Two other ceilings bind first — §3.2.

### 1.2 The constraint that actually binds is answer-cache key cardinality.

`research.py:_cache_scope` folds `sha1(composed_memory)[:12]` into the answer-cache key. Every distinct composed memory block is a distinct cache namespace. Measured effect, 1,000 traders asking one canonical question in one 5-minute window:

| What is in the memory block | Distinct blocks | Cache hit rate | Scholar generations |
|---|---:|---:|---:|
| `memoryLab` OFF | 1 | 99.9% | 1 / 1,000 |
| PLATFORM + VENUE docs only | 1 | 99.9% | 1 / 1,000 |
| + USER facts, 10% of traders have them | 101 | 89.9% | 101 / 1,000 |
| + USER facts, 50% of traders | 501 | 49.9% | 501 / 1,000 |
| + USER facts, steady state (90%) | 901 | **9.9%** | 901 / 1,000 |
| + SESSION facts (per session) | 1,000 | **0.0%** | 1,000 / 1,000 |

The per-Trader layers of that block measure **62 tokens** — 0.0062% of the 1M ceiling. Those 62 tokens are the difference between 1 Scholar generation and ~900.

Victor's own note flags the direction (`Cache for Sudha.md` §4: *"turning memoryLab on … fragments the cache"*). This is the magnitude. The 49% effective cache rate in cost model v4 is **not survivable** with per-Trader content in the Scholar cache key at steady state — the arithmetic lands near 10%.

> This is the whole design problem. Not tokens. Cardinality.

### 1.3 "External Data" does not exist yet.

`services/market-data` returns exactly one shape (`Snapshot`, 136 tokens): symbol, last, 12h change, funding rate, a 13-point spark, as-of, sources. Sourced from CCXT (`MARKET_EXCHANGE`, default `binanceus`).

There is **no news, web, on-chain, liquidation or research retrieval anywhere in the codebase.** `01 System Architecture` promises "price, funding, news, on-chain, liquidations"; only price and funding are built. The string `NEWS ×2` appears in exactly two places — `services/mock-gateway/src/golden.ts:47` and `packages/protocol/test/protocol.test.ts:20` — both fixtures. The packet must model External Data as a **provider-plural array from day one** (§2.3) or every future source becomes a schema break, but Suresh should know he is wiring one provider, not five.

---

## 2 · Part 1 — the Prompt Packet schema

### 2.1 Design rules

1. **Every field carries a cardinality tier.** The tier — not the size — decides which call the field may enter and whether it may touch a cache key. This is the load-bearing rule; §3.3 defines the tiers.
2. **Numbers are retrieval, prose is generation.** Preserved verbatim from `research.py`. The Scholar may emit `headline`, `paragraphs`, `followups` and nothing else. `stats`, `spark`, `sources`, `asOfIso` are stamped server-side from the snapshot. Any output schema that lets the Scholar emit a figure re-opens hallucinated-price risk that is currently structurally impossible.
3. **The guardrail is not a packet field.** `HIPPO_SYSTEM_PROMPT_V0` (363 tok) is prepended by the Model Server, outside the packet, and memory composes *beneath* it (`MEMORY_CONTEXT_PREFIX`). If the guardrail becomes a packet field, a malformed packet can drop product law. It must be unrepresentable-as-absent.
4. **Inline by default only below 200 tokens and above tier 2.** Everything per-Trader and everything volatile is a reference the server resolves — never a blob the Scholar carries.
5. **Every field is nullable and the packet is valid without it.** Every upstream (memory, seam, market-data) already has a documented degrade-to-empty contract. The packet must not be the thing that turns a degraded dependency into a failed turn.

### 2.2 Field grounding — source of truth for every value

#### ① `host_context` — about the Host (partner exchange). Tier 1.

| Sub-field | Source | Inline/ref | Req | Measured size |
|---|---|---|---|---|
| `host_id` | `partners.partner_id` (mig 001) | inline | ✅ | ~5 tok |
| `venue_name` | `partners.venue_name` | inline | ✅ | ~3 tok |
| `locales` | `partners.locales` | inline | ✅ | ~8 tok |
| `venue_doc` | `memory_host.body` (mig 009) | inline | ⬜ | ≤ 8,000 ch = **1,629 tok** |
| `capabilities` | seam `GET /v1/capabilities` → `VenueCapabilities` | inline | ⬜ | **51 tok** |
| `entitlements` | `plans.entitlements` (mig 002) | inline (control only) | ✅ | ~15 tok |
| `suggested_queries` | `partners.suggested_queries` | ref | ⬜ | — |

**`capabilities` is currently never sent to any model.** PR #106 fixed a bug where a perp ask on a spot-only venue was silently rewritten to a spot plan; the fix was gateway-side gating. Putting capabilities in the packet is the structural version of that fix — the Scholar stops being able to describe a trade the venue cannot do. Recommended: include. Costs 51 tokens at tier 1 (i.e. amortized across the whole Host).

#### ② `trader_persona` — about the individual Trader. Tier 3. **Never reaches the Scholar.**

| Sub-field | Source | Inline/ref | Req | Measured size |
|---|---|---|---|---|
| `experience_level` | `users_memory.experience_level` (mig 004) | inline | ⬜ | ~2 tok |
| `followed_assets` | `users_memory.followed_assets`, capped 8 in store, 5 in render | inline | ⬜ | ~10 tok |
| `open_threads` | `users_memory.open_threads`, cap 3, 300 ch each | ref | ⬜ | — |
| `curated_note` | `memory_user_notes.body` (mig 009) | inline | ⬜ | ≤ 8,000 ch = 1,629 tok |
| `learned_facts` | `memory_learned_facts` scope=`user` (mig 011) | inline | ⬜ | ≤20 rendered = **160 tok** (≤50 stored = 400 tok) |
| `consent` | `users_memory.opt_in` + `.learn_opt_out` (mig 012) | inline (control) | ✅ | ~6 tok |

Three independent consent gates already govern this field and the packet must respect all three, unchanged: plan `entitlements.memoryLab`, `persona.optIn`, `persona.learnOptOut`. Fact decay is 90 days (`LEARNED_FACT_TTL_MS`); `source: 'admin'` facts are exempt. The five allowed `fact_type` values are a closed allowlist enforced twice (prompt + `extract.py`) — do not widen it in the packet.

#### ③ `query` — the question plus conversation context. Tier 4.

| Sub-field | Source | Inline/ref | Req | Measured size |
|---|---|---|---|---|
| `raw_text` | uplink, `Field(max_length=4000)` | inline | ✅ | 5–1,000 tok |
| `restructured` | Scout ingress output | inline | ✅ (to Scholar) | **16 tok** typical |
| `history` | `assembleHistory()` — journal-derived, ≤6 exchanges / ≤12 items / ≤240 ch each / **≤1,200 ch total** | inline | ⬜ | **231 tok** at cap |
| `language` | Scout ingress (`en`/`hi`/`hinglish`) | inline | ✅ | 1 tok |
| `page_symbol` | `data-hippo-symbol` context uplink, validated by `normalizeSymbol` | inline | ⬜ | ~4 tok |

**`history` is ingress-only and must stay that way.** `orchestrator/index.ts:309-311` and `prompts.py:186-188` both state the rule: history feeds the interpret stage so `restructured` stands alone, and never reaches the research stage or its cache key. `restructured` **is** the compression of history — the threading mechanism already exists here in embryo (§3.4).

#### ④ `host_data` — the exchange's own data about this Trader. Tier 3–4, volatile. **Reference, not inline.**

| Sub-field | Source | Inline/ref | Req | Measured size |
|---|---|---|---|---|
| `positions` | seam `GET /v1/portfolio` → `SeamPortfolio.positions` | **ref** | ⬜ | 49 tok/row |
| `open_orders` | same → `.openOrders` | **ref** | ⬜ | 35 tok/row |
| `orders_blotter` | seam `GET /v1/orders` → `OrderRecord[]`, **capped 50** (`index.ts:2040`) | **ref** | ⬜ | 77 tok/row; **3,803 tok at cap** |
| `uploaded_files` | `uploaded_files` (mig 016) → bounded digest, ≤12 columns / ≤6 totals, summary ≤400 ch | **ref** | ⬜ | ~150 tok/digest |

Today **none of this reaches a model.** Portfolio and blotter render as deterministic cards; only the file digest ever enters a prompt, and only for the file-analysis path. That is a correct decision and the packet should encode it as a rule, not an accident: a Trader's live position set is the highest-cardinality, fastest-moving data in the system, and inlining it into the Scholar would make every research answer uncacheable *and* stale within seconds.

Model it as `{ref, kind, as_of, digest?}` where `digest` is a bounded server-authored line the Scout egress pass may use. The Scholar resolves nothing.

#### ⑤ `external_data` — outside data. Tier 2 (per symbol + 5-min window).

| Sub-field | Source | Inline/ref | Req | Measured size |
|---|---|---|---|---|
| `market_snapshot` | `market-data GET /v1/snapshot` (CCXT) | inline | ⬜ | **136 tok** |
| `providers[]` | — | — | — | **only one exists today** |

Snapshot shape is fixed: `{symbol, last, lastDisplay, change12hPct, change12hDisplay, fundingRate, fundingDisplay, spark[13], asOfIso, sources[]}`. `fundingRate` is `null` on Binance.US (spot-only) and degrades gracefully.

This is the **highest-value tier in the packet** (§3.5): it is shared by every Trader asking about that symbol in that window, so enrichment here is amortized across the whole fleet.

#### ⑥ `output_schema` — the shape the answer must return in. Tier 0.

| Sub-field | Source | Inline/ref | Req | Measured size |
|---|---|---|---|---|
| `format` | `BRIEF_FORMAT_INSTRUCTIONS` | inline | ✅ | **102 tok** |
| `contract_ref` | `packages/protocol` `ResearchBriefFrame` (Zod) | ref | ✅ | — |
| `constraints` | `MAX_PARAGRAPHS=3`, `MAX_PARAGRAPH_WORDS=60`, headline ≤12 words, exactly 2 followups | inline | ✅ | included above |

The Zod frame is the authority; the prompt text is a projection of it. Today they are maintained by hand in two places. **Recommend a parity test** in the same spirit as `test_taxonomy_parity.py` / `intent-parity.test.ts` — the August 2026 sync wave (#111) exists entirely because a fourth consumer of a shared taxonomy had nothing gating it.

### 2.3 The schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hippo.app/schemas/prompt-packet/v1",
  "title": "Hippo Prompt Packet v1",
  "type": "object",
  "required": ["packet_version", "packet_id", "call", "issued_at", "query", "output_schema", "cache"],
  "additionalProperties": false,

  "properties": {
    "packet_version": { "const": 1,
      "description": "Additive-only, mirroring packages/protocol. A breaking change is a new major." },
    "packet_id": { "type": "string", "pattern": "^pkt_[a-z0-9]{16}$" },
    "call": { "enum": ["scout_ingress", "scholar", "scout_egress"],
      "description": "Which of the three model calls this packet is built for. The builder MUST omit every field whose tier exceeds the call's max_tier (see §3.3)." },
    "issued_at": { "type": "string", "format": "date-time" },
    "trace_id": { "type": "string", "description": "OTel trace id; joins the three calls of one turn." },

    "host_context": {
      "type": ["object", "null"], "description": "TIER 1 — per Host.",
      "additionalProperties": false,
      "required": ["host_id", "venue_name"],
      "properties": {
        "host_id":    { "type": "string", "maxLength": 64, "x-source": "partners.partner_id" },
        "venue_name": { "type": "string", "maxLength": 64, "x-source": "partners.venue_name" },
        "locales":    { "type": "array", "items": { "type": "string" }, "maxItems": 8,
                        "x-source": "partners.locales" },
        "venue_doc":  { "type": ["string", "null"], "maxLength": 8000,
                        "x-source": "memory_host.body (mig 009)",
                        "x-max-tokens": 1629 },
        "capabilities": {
          "type": ["object", "null"], "x-source": "seam GET /v1/capabilities",
          "x-max-tokens": 51,
          "description": "NOT sent to any model today. Including it is the structural form of the PR #106 fix.",
          "properties": {
            "spot":         { "$ref": "#/$defs/capability" },
            "futures_perp": { "$ref": "#/$defs/capability" },
            "options":      { "$ref": "#/$defs/capability" }
          }
        },
        "entitlements": { "type": "object", "x-source": "plans.entitlements (mig 002)",
          "x-control-only": true,
          "description": "Routing/gating only. MUST NOT be rendered into any prompt." }
      }
    },

    "trader_persona": {
      "type": ["object", "null"],
      "description": "TIER 3 — per Trader. MUST be null when call == 'scholar'.",
      "additionalProperties": false,
      "required": ["consent"],
      "properties": {
        "consent": {
          "type": "object", "required": ["memory_lab", "opt_in", "learn_opt_out"],
          "description": "All three gates must pass before any sibling field is populated.",
          "properties": {
            "memory_lab":     { "type": "boolean", "x-source": "plans.entitlements.memoryLab" },
            "opt_in":         { "type": "boolean", "x-source": "users_memory.opt_in (mig 004)" },
            "learn_opt_out":  { "type": "boolean", "x-source": "users_memory.learn_opt_out (mig 012)" }
          }
        },
        "experience_level": { "enum": ["new", "intermediate", "pro", null],
                              "x-source": "users_memory.experience_level" },
        "followed_assets":  { "type": "array", "items": { "type": "string", "maxLength": 10 },
                              "maxItems": 5, "x-source": "users_memory.followed_assets" },
        "curated_note":     { "type": ["string", "null"], "maxLength": 8000,
                              "x-source": "memory_user_notes.body (mig 009)" },
        "learned_facts": {
          "type": "array", "maxItems": 20, "x-max-tokens": 160,
          "x-source": "memory_learned_facts scope='user' (mig 011)",
          "items": {
            "type": "object", "required": ["type", "value", "source"],
            "properties": {
              "type":       { "enum": ["followed_asset", "instrument_pref", "leverage_pref",
                                       "experience_level", "answer_style"],
                              "description": "CLOSED allowlist. Enforced in prompts.py AND extract.py. Do not widen here." },
              "value":      { "type": "string", "maxLength": 32 },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
              "source":     { "enum": ["auto", "admin"],
                              "description": "'admin' outranks 'auto' and is exempt from the 90-day decay." }
            }
          }
        },
        "open_threads": { "$ref": "#/$defs/reference" }
      }
    },

    "query": {
      "type": "object", "description": "TIER 4 — per turn.",
      "required": ["raw_text", "language"],
      "additionalProperties": false,
      "properties": {
        "raw_text":     { "type": "string", "minLength": 1, "maxLength": 4000 },
        "restructured": { "type": ["string", "null"], "maxLength": 4000,
                          "description": "Scout-ingress output. Self-contained: resolves every pronoun and follow-up. This IS the compression of `history` — see §3.4. REQUIRED when call == 'scholar'." },
        "language":     { "enum": ["en", "hi", "hinglish"] },
        "page_symbol":  { "type": ["string", "null"], "pattern": "^[A-Z0-9]{2,10}/[A-Z0-9]{2,10}$" },
        "history": {
          "type": "array", "maxItems": 12, "x-max-tokens": 231,
          "description": "MUST be absent when call == 'scholar'. Bounds enforced by assembleHistory(): ≤6 exchanges, ≤240 ch/item, ≤1200 ch total.",
          "items": {
            "type": "object", "required": ["role", "text"],
            "properties": {
              "role": { "enum": ["user", "assistant"] },
              "text": { "type": "string", "maxLength": 240 }
            }
          }
        }
      }
    },

    "host_data": {
      "type": ["object", "null"],
      "description": "TIER 3/4, volatile. REFERENCES ONLY — the Scholar resolves nothing. MUST be null when call == 'scholar'.",
      "additionalProperties": false,
      "properties": {
        "positions":      { "$ref": "#/$defs/reference" },
        "open_orders":    { "$ref": "#/$defs/reference" },
        "orders_blotter": { "$ref": "#/$defs/reference",
                            "description": "seam GET /v1/orders, capped at 50 rows = 3,803 tok if ever inlined." },
        "uploaded_files": { "type": "array", "maxItems": 5, "items": { "$ref": "#/$defs/reference" } }
      }
    },

    "external_data": {
      "type": ["object", "null"],
      "description": "TIER 2 — per (symbol, 5-min window). The amortized tier: spend here, not on tier 3.",
      "additionalProperties": false,
      "properties": {
        "market_snapshot": {
          "type": ["object", "null"], "x-max-tokens": 136,
          "x-source": "market-data GET /v1/snapshot (CCXT, MARKET_EXCHANGE default binanceus)",
          "required": ["symbol", "asOfIso", "sources"],
          "properties": {
            "symbol":             { "type": "string" },
            "last":               { "type": "number" },
            "lastDisplay":        { "type": "string" },
            "change12hPct":       { "type": "number" },
            "change12hDisplay":   { "type": "string" },
            "fundingRate":        { "type": ["number", "null"],
                                    "description": "null on spot-only exchanges (Binance.US). Degrades gracefully." },
            "fundingDisplay":     { "type": ["string", "null"] },
            "spark":              { "type": "array", "items": { "type": "number" }, "minItems": 2,
                                    "description": "13 hourly closes = the 12h window. Also drives volatility_scaled_ttl()." },
            "asOfIso":            { "type": "string", "format": "date-time" },
            "sources":            { "type": "array", "items": { "type": "string" } }
          }
        },
        "providers": {
          "type": "array", "default": [],
          "description": "PLURAL FROM DAY ONE so a second source is additive, not a schema break. Empty today — no news/web/on-chain retrieval exists anywhere in the repo (see §1.3).",
          "items": {
            "type": "object", "required": ["provider", "as_of", "payload"],
            "properties": {
              "provider": { "type": "string" },
              "as_of":    { "type": "string", "format": "date-time" },
              "tier":     { "const": 2,
                            "description": "A provider that cannot be keyed by (symbol, window) is tier 3 and does not belong here." },
              "payload":  { "type": "object" }
            }
          }
        }
      }
    },

    "output_schema": {
      "type": "object", "description": "TIER 0 — fleet-invariant.",
      "required": ["kind", "contract_ref"],
      "additionalProperties": false,
      "properties": {
        "kind":         { "enum": ["brief", "decline", "intent", "facts", "personalized_brief"] },
        "contract_ref": { "type": "string",
                          "description": "e.g. '@hippo/protocol#ResearchBriefFrame'. The Zod schema is the authority; prompt text is a projection." },
        "constraints": {
          "type": "object",
          "properties": {
            "max_paragraphs":      { "type": "integer", "default": 3 },
            "max_paragraph_words": { "type": "integer", "default": 60 },
            "max_headline_words":  { "type": "integer", "default": 12 },
            "followups":           { "type": "integer", "default": 2 }
          }
        },
        "generation_scope": {
          "type": "array", "default": ["headline", "paragraphs", "followups"],
          "description": "PRODUCT LAW: the only keys a model may emit. stats/spark/sources/asOfIso are stamped server-side from the snapshot. Widening this re-opens hallucinated-figure risk that is currently structurally impossible."
        }
      }
    },

    "carry_forward": { "$ref": "#/$defs/carry_forward" },

    "cache": {
      "type": "object",
      "description": "The economics. See §3.3 — this is the tightest budget in the system.",
      "required": ["cacheable", "key_material"],
      "properties": {
        "cacheable": { "type": "boolean",
                       "description": "false for any packet carrying a field of tier > 2." },
        "key_material": {
          "type": "object",
          "description": "EXHAUSTIVE list of what may enter the answer-cache key. A builder that adds a tier-3 value here has broken the rate card.",
          "required": ["canonical_question", "asset", "language", "window_bucket"],
          "properties": {
            "canonical_question": { "type": "string", "x-source": "cache.py:canonicalize()" },
            "asset":              { "type": "string" },
            "language":           { "enum": ["en", "hi", "hinglish"] },
            "window_bucket":      { "type": "integer", "x-source": "cache.py:window_bucket() — 300s" },
            "host_id":            { "type": ["string", "null"],
                                    "description": "Present iff host_context.venue_doc is non-empty. Tier 1 = per-Host cache namespace, which is affordable." },
            "experience_level":   { "enum": ["new", "intermediate", "pro", null],
                                    "description": "CONCEPT answers only, exactly as _cache_scope does today. 3 values = 3 namespaces, affordable. Market briefs stay fleet-wide." }
          },
          "additionalProperties": false
        },
        "ttl_s": { "type": "number",
                   "description": "volatility_scaled_ttl(spark): 300s calm / 120s default / 45s volatile." }
      }
    }
  },

  "$defs": {
    "capability": {
      "type": "object",
      "properties": {
        "orderTypes":       { "type": "array", "items": { "enum": ["market", "limit"] } },
        "maxLeverage":      { "type": "number" },
        "marginModes":      { "type": "array", "items": { "enum": ["isolated", "cross"] } },
        "protectiveExits":  { "type": "boolean" }
      }
    },
    "reference": {
      "type": ["object", "null"],
      "description": "Reference-not-inline. The packet carries a pointer plus a bounded server-authored digest; the resolver is named so the egress pass can fetch on demand.",
      "required": ["ref", "resolver"],
      "properties": {
        "ref":      { "type": "string", "description": "opaque handle, e.g. 'seam:portfolio:{partnerId}:{userId}'" },
        "resolver": { "type": "string", "description": "the service+route that resolves it" },
        "as_of":    { "type": ["string", "null"], "format": "date-time" },
        "count":    { "type": ["integer", "null"] },
        "digest":   { "type": ["string", "null"], "maxLength": 400,
                      "description": "Bounded, server-authored, safe to render. NEVER the raw payload." }
      }
    },
    "carry_forward": {
      "type": ["object", "null"],
      "description": "THE THREADING MECHANISM — §3.4. Written by Scout ingress, consumed by Scholar. Fixed schema, hard token budget, no free text outside the named slots.",
      "additionalProperties": false,
      "required": ["from_call", "budget_tokens"],
      "properties": {
        "from_call":     { "enum": ["scout_ingress", "scholar"] },
        "budget_tokens": { "type": "integer", "maximum": 512,
                           "description": "Hard cap. The builder MUST measure and truncate slot-wise, lowest-priority slot first." },
        "intent":        { "enum": ["research", "concept", "action", "advice", "portfolio",
                                    "smalltalk", "host_action", "orders_query", "alert"],
                           "description": "Kept EQUAL to intent.py INTENTS / prompts.py enum / gateway IntentKind / evals INTENTS — four surfaces, already parity-tested." },
        "confidence":    { "type": "number", "minimum": 0, "maximum": 1,
                           "description": "Bimodal by construction: fast paths 0.92–0.97, rule_classify 0.6–0.8. Thresholds: 0.40 nudge, 0.85 clarify-if-costly." },
        "resolved_entities": {
          "type": "object", "x-max-tokens": 64,
          "description": "What the ingress pass resolved OUT of history so the Scholar never needs history.",
          "properties": {
            "symbol":       { "type": ["string", "null"] },
            "timeframe":    { "type": ["string", "null"] },
            "referent":     { "type": ["string", "null"],
                              "description": "What a pronoun resolved to, e.g. 'it' -> 'BTC/USDT'." }
          }
        },
        "answer_shape":  { "type": ["string", "null"], "maxLength": 120,
                           "description": "Ingress-decided rendering hint, e.g. 'compare two assets'. NOT content." },
        "depth":         { "enum": ["new", "intermediate", "pro", null],
                           "description": "The ONLY tier-3-derived value permitted to cross into the Scholar, and only for CONCEPT answers — mirroring _cache_scope today (3 namespaces, not N). For market briefs this MUST be null." },
        "declined":      { "type": "boolean",
                           "description": "Ingress advice-check result. true short-circuits the Scholar entirely." }
      }
    }
  }
}
```

### 2.4 Worked example — a research turn, `call: "scholar"`

```json
{
  "packet_version": 1,
  "packet_id": "pkt_7f3a91c2e4b60d18",
  "call": "scholar",
  "issued_at": "2026-08-10T09:23:11.412Z",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",

  "host_context": {
    "host_id": "assetworks-demo",
    "venue_name": "Assetworks",
    "locales": ["en", "hi", "hi-Latn"],
    "venue_doc": "Assetworks is a spot + perpetuals venue, USDT-quoted, max 50x leverage...",
    "capabilities": {
      "spot": { "orderTypes": ["market", "limit"], "protectiveExits": true },
      "futures_perp": { "orderTypes": ["market", "limit"], "maxLeverage": 50,
                        "marginModes": ["isolated", "cross"], "protectiveExits": true }
    },
    "entitlements": { "memoryLab": true }
  },

  "trader_persona": null,
  "host_data": null,

  "query": {
    "raw_text": "what about it now",
    "restructured": "What is driving the decline in Bitcoin (BTC/USDT) price today?",
    "language": "en",
    "page_symbol": "BTC/USDT"
  },

  "external_data": {
    "market_snapshot": {
      "symbol": "BTC/USDT", "last": 61240, "lastDisplay": "61,240",
      "change12hPct": -4.18, "change12hDisplay": "−4.2%",
      "fundingRate": -0.00008, "fundingDisplay": "−0.008%",
      "spark": [63910,63780,63985,63820,63640,63210,62880,62650,62410,61980,61560,61410,61240],
      "asOfIso": "2026-08-10T09:23:11.412Z",
      "sources": ["BINANCEUS PUBLIC", "FUNDING"]
    },
    "providers": []
  },

  "output_schema": {
    "kind": "brief",
    "contract_ref": "@hippo/protocol#ResearchBriefFrame",
    "constraints": { "max_paragraphs": 3, "max_paragraph_words": 60,
                     "max_headline_words": 12, "followups": 2 },
    "generation_scope": ["headline", "paragraphs", "followups"]
  },

  "carry_forward": {
    "from_call": "scout_ingress",
    "budget_tokens": 512,
    "intent": "research",
    "confidence": 0.94,
    "resolved_entities": { "symbol": "BTC/USDT", "timeframe": "12h", "referent": "it -> BTC/USDT" },
    "answer_shape": "single-asset move explanation",
    "depth": null,
    "declined": false
  },

  "cache": {
    "cacheable": true,
    "key_material": {
      "canonical_question": "why-down:BTC",
      "asset": "BTC",
      "language": "en",
      "window_bucket": 5954512,
      "host_id": "assetworks-demo",
      "experience_level": null
    },
    "ttl_s": 120
  }
}
```

Note what is **absent**: `trader_persona`, `host_data`, `query.history`. Their absence is what keeps `cache.cacheable: true`. The trader's memory has not been discarded — it is applied on the way out, at Scout egress.

---

## 3 · Part 2 — the threading mechanism

### 3.1 Measured token sizes — every artifact that reaches a model today

| Artifact | Chars | Tokens |
|---|---:|---:|
| `HIPPO_SYSTEM_PROMPT_V0` (guardrail) | 1,682 | **363** |
| `INTENT_SYSTEM_PROMPT` (Scout ingress) | 6,483 | **1,826** |
| `INTENT_HISTORY_SUFFIX` | 422 | 96 |
| `EXTRACT_SYSTEM_PROMPT` (Scout egress) | 2,036 | 488 |
| `MEMORY_CONTEXT_PREFIX` | 321 | 58 |
| `BRIEF_FORMAT_INSTRUCTIONS` (output schema) | 421 | 102 |
| Market snapshot, serialized | 329 | **136** |
| Composed memory, realistic (4 layers) | 577 | **157** |
| — of which per-Trader (USER + SESSION) | 232 | **62** |
| History at `HISTORY_MAX_CHARS` | 1,196 | 231 |
| One scope doc at `MAX_BODY` | 8,000 | 1,629 |
| Composed at `MAX_COMPOSED` | 64,000 | 13,001 |
| Orders blotter at 50-row cap | 9,801 | 3,803 |
| `IntentResult` (Scout output, order case) | 395 | 113 |
| Brief JSON (Scholar output) | 511 | 129 |

### 3.2 Three candidate ceilings. The 1M one is not the binding one.

| Ceiling | Value | Call-2 usage today | Binding? |
|---|---:|---:|---|
| **Context window** | 1,000,000 tok | 883 tok (0.088%) | **No** — 3 orders of magnitude of slack |
| **First-token latency** (PRD §5: <2s p95 on a miss) | ~16,000 tok of prefill | 883 tok (5.5%) | **Second** |
| **Cache-key cardinality** (the rate card) | ~1 namespace per (Host, asset, lang, window) | 1 → up to 1,000 | **Yes — this is the one** |

The latency figure assumes ~8,000 tok/s prefill for a 27–30B dense model on a single H100 at batch 1. **[assumption — unverified]** That number is exactly what the rented-H100 exam should measure; it moves the second ceiling by a factor of several either way. It does not change the conclusion, because the third ceiling binds two orders of magnitude earlier.

**Also [unverified]: whether a 1M ceiling is achievable at all with the shortlisted Scholars.** Qwen3-class checkpoints are commonly 32k native / ~131k with YaRN; Granite 4.x is commonly 128k. None of the three shortlisted Scholars (Qwen3.6-27B dense, Granite-4.1-30b, Qwen3.6-35B-A3B) is known to me to ship a 1M native window. Verify per exact checkpoint before any design assumes it — same discipline the licence column already forced.

### 3.3 The mechanism: partition by cardinality tier, not by size

Assign every packet field a tier = *how many distinct values it takes across the fleet*.

| Tier | Varies per | Distinct values | Fields | May enter Scholar? | May enter cache key? |
|---|---|---|---|---|---|
| **0** | nothing | 1 | `output_schema`, guardrail, few-shots | ✅ | ✅ (free) |
| **1** | Host | ~10² | `host_context.*` | ✅ | ✅ (affordable) |
| **2** | symbol × 5-min window | ~10³/day/symbol | `external_data.*` | ✅ | ✅ (this IS the key) |
| **3** | Trader | ~10⁵–10⁶ | `trader_persona.*`, `host_data.*` | ❌ | ❌ **never** |
| **4** | session / turn | ~10⁷ | `query.history`, session facts | ❌ | ❌ **never** |

**The rule, in one line:** *a field may enter the Scholar call if and only if its tier ≤ 2. Everything above tier 2 is applied by Scout on the way out.*

This is not a new architecture. It is the architecture already decided (handoff A8: "Scout runs twice per research query; the Egress Doorway is a Scout function"), given the rule that makes it economically necessary.

Two tier-2-or-below exceptions are already in the code and should be preserved verbatim:
- `experience_level` scopes **concept** answers only (3 namespaces, not N). Market briefs stay fleet-wide. `research.py:_cache_scope`.
- `host_id` enters the key iff `venue_doc` is non-empty — a per-Host namespace, which is affordable.

### 3.4 The three options, evaluated against the measured numbers

**Option A — Structured summary (fixed carry-forward sub-schema).**
Cost: ≤512 tok budget; realistic fill ~60 tok. Cardinality impact: **zero if every slot is tier ≤2.** Fidelity: high for entities and routing, lossy for nuance. Failure mode: a slot the ingress pass fills wrong propagates silently — mitigated because every slot is a closed enum or a short string a human can read on the UNDERSTOOD card.
**This already exists in embryo:** `restructuredQuery` is precisely a structured compression of `history` into a self-contained string, and `assembleHistory` → `restructured` → Scholar is a working carry-forward today. `interpretation` is its human-readable twin, already rendered on the UNDERSTOOD card. Extending a mechanism that ships beats inventing one.

**Option B — Conclusions-not-working.**
This is not an option; it is an existing invariant, and stating it as a choice risks losing it. `research.py` already discards all working state: the Scholar receives a 136-token snapshot and returns 129 tokens of prose, and `stats`/`spark`/`sources`/`asOfIso` are stamped from the snapshot, never from the model. There is no retrieved source text to drop because there is no retrieval corpus (§1.3). **Encode it as `output_schema.generation_scope`** — a rule the packet enforces — rather than a threading strategy to pick.

**Option C — Reference-not-inline.**
Correct and necessary, but for `host_data`, not for the Scout→Scholar seam. The blotter at cap is 3,803 tokens of tier-3 data that would both blow cacheability and be stale within seconds. Model it as `$defs/reference` with a ≤400-char server-authored digest. Note the packet-builder must **not** give the Scholar a resolver it can call — that would let a cached artifact depend on live per-Trader state.

### 3.5 Recommendation

**Adopt A as the Scout→Scholar mechanism, C for `host_data`, and freeze B as an invariant.** Concretely:

1. `carry_forward` (§2.3) is the compress-forward channel. Fixed slots, closed enums, **512-token hard cap**, truncated slot-wise lowest-priority-first. No free text outside named slots.
2. **`cache.key_material` is a closed list with `additionalProperties: false`.** This is the single most important line in the schema. A builder that adds a tier-3 value there has silently broken the rate card, and — as PR #105 proved — a thing with nothing gating it drifts. Ship it with a test that asserts the key material contains no tier-3 field, in the same family as `intent-parity.test.ts`.
3. Per-Trader personalization moves to **Scout egress**, which already runs on every turn including cache hits.
4. `depth` is the sole tier-3-derived value allowed across, concept-answers-only, exactly mirroring `_cache_scope` today.

**Budget under the three ceilings:**

| | Scout ingress | Scholar | Scout egress |
|---|---:|---:|---:|
| System prompt | 1,826 | 363 + 58 | ~488 |
| Packet, tier ≤2 | — | 820 | — |
| Packet, tier ≥3 | 236 (history + query) | **0** | ~230 |
| `carry_forward` | — | ~60 | ~190 (Scholar's brief) |
| **Total input** | **~2,160** | **~1,300** | **~910** |
| % of 1M ceiling | 0.22% | **0.13%** | 0.09% |
| % of ~16k latency ceiling | 13.5% | **8.1%** | 5.7% |
| Cache namespaces | n/a | **1 per (Host, asset, lang, window)** | n/a |

### 3.6 The inversion — what to do with 999,000 unused tokens

Since the ceiling does not bind, the useful question is not "how do we fit under 1M" but "what is worth spending headroom on." The tier model answers it, because **cost per Trader = tokens ÷ number of Traders sharing that cache namespace**:

| Spend 50,000 tokens on… | Tier | Shared by | Marginal cost per Trader |
|---|---|---|---:|
| Market context per symbol-window (depth, liquidations, funding history, news when it exists) | 2 | every Trader asking that symbol that window | **50 tok** at 1,000 Traders |
| Host documentation / venue rules corpus | 1 | every Trader on that Host | **~0 tok** |
| Hinglish + Devanagari few-shot exemplars | 0 | the entire fleet | **~0 tok** |
| The Trader's own history and positions | 3 | nobody | **50,000 tok** |

Same 50,000 tokens. A **1,000× spread** in cost, decided entirely by tier.

The tier-0 row is the immediate opportunity: measured intent accuracy is **95.3% en / 31.0% hinglish / 5.0% Devanagari** (PR #103, fresh harness run). Devanagari few-shots are fleet-invariant, amortize to approximately zero, and attack the largest measured quality gap in the product. That is where the headroom should go first — not into per-Trader context, which is the one place it cannot afford to go.

Latency still bounds any single call to roughly 16k tokens on a cache miss **[assumption, see §3.2]**, so this is a staged spend, not a dump.

---

## 4 · CONFIRM WITH VICTOR / SURESH

Ordered by consequence.

1. **Does per-Trader memory keep fragmenting the Scholar cache key, or move to Scout egress?** Everything in this spec follows from the answer. Measured: ~10% hit rate at steady state if it stays vs ~99% if it moves, against a 49% assumption in cost model v4. **Victor** (owner of `_cache_scope`) **+ Sudha** (owner of the rate card).
2. **Is the 1M ceiling real for the shortlisted Scholars?** Verify native context length per exact checkpoint (Qwen3.6-27B dense, Granite-4.1-30b, Qwen3.6-35B-A3B) before any design assumes it. The licence column already taught this lesson: verify per model+size, never assume from family. **[unverified]**
3. **What is real prefill throughput for a 27–30B on the exam H100?** Sets the second ceiling (~16k tok assumed here). The exam is already being built and should measure it. **Sudha.**
4. **Does `capabilities` enter the packet?** 51 tokens at tier 1 makes "this venue cannot do that trade" structural rather than a gateway patch (PR #106). **Victor.**
5. **Does `host_data` ever go inline?** This spec says never — reference + ≤400-char digest only. Confirms the portfolio/blotter stay deterministic cards. **Victor.**
6. **Who owns `output_schema` ↔ Zod parity?** The Zod frame and `BRIEF_FORMAT_INSTRUCTIONS` are hand-maintained in two places. Recommend a parity test. **Suresh.**
7. **Is `interpretation` (the UNDERSTOOD card) part of the packet contract or a gateway concern?** It is currently the human-readable twin of `carry_forward`. If it is contractual, it needs a slot. **Victor.**
8. **Packet versioning policy.** Assumed additive-only mirroring `packages/protocol`. Confirm the same rule applies. **Victor.**
9. **`open_threads` — reference or drop?** Capped at 3 × 300 ch in `services/memory/src/store.ts`, and nothing currently reads them into a prompt. May be dead weight. **Victor.**
10. **Does the egress pass get to re-order or re-word Scholar prose, or only wrap it?** Determines whether the guardrail must re-run on the egress output. Compliance-relevant. **Victor + counsel.**

---

## 5 · Defects found while grounding this spec

Reported because they are load-bearing for the packet, not as scope creep.

### 5.1 🔴 A composed memory block larger than 16,000 characters silently degrades every research turn

- `services/intelligence/main.py:116` — `memoryContext: str | None = Field(default=None, max_length=16_000)`
- `services/memory/src/scope-store.ts:33-35` — the store's own comment computes the max composed block at **"~33k chars of structure"** (4 layers × `MAX_BODY` 8,000 + labels + persona line + fact lines) and sets `MAX_COMPOSED = 64_000` accordingly.
- `orchestrator/memory-compose.ts` does **not** clamp, and no clamp exists anywhere on the gateway path (`grep` for `16_000` / `MAX_COMPOSED` in `services/gateway/src/orchestrator/` returns nothing).

The label overhead is 79 characters, so four full scope docs compose to 32,079 characters before the persona line and fact lines are added (~33.3k total — matching the store's own estimate). A Host whose four scope docs total more than **15,921** characters produces a block Pydantic rejects with a 422. `postJson` throws on non-2xx → `guardedStream` trips the breaker → the orchestrator catches and enters degraded mode. Result: **every research turn silently falls back to a market-data-only brief for 15 seconds at a time**, with no operator-visible error. The failure is safe but invisible, and it gets more likely the more diligently an operator uses the Memory Config editor.

Fix options: clamp gateway-side before send (loses the tail — i.e. the USER/SESSION layers, which is the same bug `MAX_COMPOSED` was raised to avoid), or raise the Pydantic limit to 64,000 to match the store. **Recommend raising the limit** and adding a test asserting the two constants agree — the mismatch is the defect, not the value.

### 5.2 🟡 Cache fragmentation from `memoryLab` is documented directionally but never quantified or measured

`Cache for Sudha.md` §4 says to "expect the hit rate to dip." §1.2 above puts it at ~10% at steady state against a 49% planning assumption. There is no telemetry on **distinct memory-block count**, so nobody would see it happen. Recommend a `distinctMemoryKeys` gauge next to the existing hit-rate stat on `/health` and the admin Pilot page.

### 5.3 🟡 `01 System Architecture` overstates the Market Data Service

It lists "price, funding, news, on-chain, liquidations." Built: price and funding. Worth correcting in the vault so the packet's `external_data.providers: []` is not read as a regression.

---

**Next:** this spec is the input to the model exam / torture list. The exam should settle §4 items 2 and 3, and should include a cardinality-regression case — a packet that puts a tier-3 field in `cache.key_material` must fail.
