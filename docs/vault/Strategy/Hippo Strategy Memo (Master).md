# Hippo App — Strategy Memo
## Positioning, Product, AI Stack, Economics & Commercial Terms

*For internal circulation among co-founders. July 2026.*

---

## 1. What we are building

Hippo App is a conversational trading agent that lives inside partner exchanges and brokers. A trader asks questions in plain language — "why is BTC down today?", "what's driving SOL volume?" — gets factual, data-grounded answers, and can act on them by placing orders through the same conversation. The exchange gets a differentiated product experience and deeper user engagement; we operate the intelligence layer behind it.

Our relationship with exchanges is symbiotic: Hippo strengthens the host. We keep the integration surface deliberately thin and easy — a partner should be able to embed Hippo with minimal engineering. The sophistication lives where it belongs: in the conversational agent itself. The product sits in a deliberate band — useful enough that traders stay, affordable enough that exchanges buy, and complex enough that they choose not to build it themselves.

## 2. The thin-client architecture

Hippo ships into a partner's app as a thin client: a lightweight SDK that renders a chat surface and a vocabulary of interactive cards. Everything intelligent — the intent engine, research models, caching, evals — runs on our infrastructure. The partner-side work is UI embedding and API credentialing: weeks, not quarters.

Thin does not mean text-only. The surface renders rich, structured components inside the conversation — an open-orders card, an order-confirmation ticket showing price, size, and fees before the user confirms, position cards with live P&L, charts embedded in research answers. These are server-driven: the SDK knows how to draw the cards; our side decides what fills them and when they appear. New card types and capabilities ship to every partner simultaneously with zero partner-side work. Structured confirmation tickets, not prose, are what make conversational trading trustworthy.

The seam between thin edge and heavy core does four jobs:

1. **Integration.** No Hippo execution engine, database, or model deploys into the partner's stack. This is what makes integration genuinely fast and the fee waiver cheap for us to offer.
2. **Fleet upgrades.** Every model improvement and new capability reaches all partners at once. The thin client is what lets a small team serve many venues — the fleet stays one product, not N installations.
3. **Moat placement.** The visible, installable part is deliberately simple — and deliberately not where the value is. The intent engine tuned on real trader phrasing, the eval harness and its conversation corpus, the caching economics: all invisible from the edge. The integration looks easy, so hosts buy; the feature set is hard, so hosts don't build. Our demos must always show the intelligence, never just the widget.
4. **Risk firewall.** Orders execute on the partner's rails, under their licenses, KYC, and custody. Hippo prepares the ticket; the partner's own APIs execute it. User funds never route through us; user PII never leaves the partner's regional pod. If Hippo pauses, trading continues — we are an enhancement in their risk review, not critical infrastructure.

**Branding: co-branded, Hippo-led — the TradingView model.** The surface wears the partner's visual language; a quiet, persistent Hippo mark lives on the chat surface and its cards; entry points read "Ask Hippo." TradingView proved the pattern: a subtle attribution on an excellent embedded tool, until brokers advertise the integration as a feature and traders treat its absence as a gap. That is the end-state we are engineering toward — partners listing Hippo as a reason to trade with them. White-label is not offered: one product, one name, on every venue.

The trade-offs are accepted deliberately. We can only do what a partner's APIs expose; we depend on their API quality for the action half of the product; and we never own the end-user relationship. Each of these costs is also precisely what makes us adoptable by the host — and is the line that separates us from wallet-owning consumer agents and agent-turned-venue plays, which validate the category while being structurally unable to serve it B2B.

## 3. The competitive landscape

Conversational trading is no longer a thesis; it is a category with volume, funding, and incumbent attention. What matters is that every serious player occupies a different structural seat than ours — and each one, examined closely, validates a piece of our design.

**Consumer agents (thick clients).** The most visible players are B2C agents that own the whole stack. HeyElsa turns plain-language requests into on-chain actions and has processed over $168 million in volume, backed by M31 Capital and Coinbase Ventures' Base Ecosystem Fund; it generates its own MPC wallets for users and executes across chains and venues itself. These products prove traders will genuinely trade through conversation — the core demand assumption of our business. But structurally they compete *with* exchanges for the user relationship, which is exactly why no exchange will ever embed one. They validate our market while being locked out of our channel.

**Agent-turned-venue plays.** Some teams concluded the agent needs to own execution and became venues outright — ClickOptions built a full crypto options exchange with its own pricing methodology and liquidity programs. Heaviest possible configuration: exchange-grade regulatory, custody, and liquidity burden. The opposite bet from ours in every respect.

**Exchange in-house assistants.** The large exchanges have built their own: Bybit's TradeGPT pairs a frontier LLM with in-house tooling for real-time market analysis and Q&A; Crypto.com launched Amy; Binance wired an AI assistant into Binance Academy. Two readings, both useful. First: the biggest venues believe conversational AI drives engagement — they are spending on exactly what we sell. Second, and more important: these are frontier-API chatbots bolted onto content and market data — analysis and education layers, not deeply integrated trading agents with intent engines, eval discipline, and order flow. And they exist only at the giants. The strategic implication is our actual market definition: **the top five exchanges will always build in-house; the next two hundred venues cannot** — no AI teams, no eval infrastructure, no appetite for GPU fleets. Hippo exists so the mid-market can field what Bybit builds.

**The newest move — exchanges opening to external agents.** In March 2026 Bybit launched AI Trading Skills: users can execute trades and manage assets in natural language through any major AI assistant — ChatGPT, Claude, Gemini and others — via 253 API endpoints. This is the inverse distribution model: instead of embedding an agent in the exchange app, the exchange exposes itself to agents living elsewhere. It concedes something we should not miss: **the conversation happens outside the exchange's app, and the engagement, context, and user attention leave with it.** Our model keeps the conversation — and the session time, the cross-sell surface, the habit — inside the partner's product. For venues whose economics depend on owning the user session, that difference is the pitch.

**B2B embedded assistants — the incumbent in our seat.** The closest structural competitor is Devexa, by trading-platform vendor Devexperts: a restylable widget promising trading from chat and engagement campaigns, white-labeled for brokers, integrated with MetaTrader, cTrader and DXtrade, and given away free to brokers licensing the DXtrade platform. Devexa validates that brokers will buy an embedded conversational layer — and shows the incumbent's ceiling. It is support-and-marketing chatbot DNA (its case studies are re-engagement campaigns and support-desk deflection), white-label by design so it builds no cross-venue brand, distributed as an add-on to a platform vendor's suite rather than as a product with its own gravity, and its intelligence is bolted-on generative AI over legacy NLU — no research engine, no eval harness, no caching economics. It is the checkbox we will be compared against in procurement, and the comparison is winnable on product depth every time. Its pricing (bundled free) also tells us something: platform vendors treat the assistant as a feature. We treat it as the product. That is only sustainable because ours does something theirs cannot: research-grade market intelligence, not scripted assistance.

**What no one occupies:** the co-branded, intelligence-heavy, execution-light seat — inside the exchange's app, on the exchange's rails, with open-source economics that survive flat pricing, and a compounding eval/data moat. Consumer agents can't enter it (they compete with the host), in-house teams won't leave their own venue, and the B2B incumbent lacks the intelligence layer. The seat is open; the category's growth is proving demand for it from every direction at once.

**What we watch.** Three moves would change this map: a frontier-model vendor shipping an embeddable trading agent SDK (the capital-rich version of us); Devexperts or a competitor platform vendor acquiring real AI depth; and the general assistants (ChatGPT, Claude, Gemini) becoming default trading front-ends via integrations like Bybit's — which would erode the premise that engagement must live in the exchange's app. None is imminent; all are watchable quarterly.

## 4. Go-to-market

**Target partner profile.** Three qualifying criteria, each anchored to an economic mechanism:

- **40,000+ monthly active traders.** The floor comes from adoption math: a well-promoted conversational feature reaches 20–25% of active traders in year one, so ~40k actives yields the ~8–10k Hippo MAU that makes the base tier a sensible purchase. Below this, the venue is buying capacity it cannot fill.
- **A production-grade trading API.** Order placement, balances, and positions must already be exposed programmatically — this is what keeps integration at weeks. A venue without one is a systems-integration project wearing a partner costume; they enter the pipeline only after their API does.
- **An active growth budget** — KOL campaigns, referral programs, trading contests. This is a buying-psychology tell: a venue already paying for engagement understands what Hippo is for and has the mental account our fee comes from. Venues that don't spend on growth will evaluate us as an IT cost and stall.

The segment this defines: venues from ~40k to ~500k active traders — the mid-market of §3's map, large enough to fill our tiers, too small to staff an AI team. Above 500k actives, venues become **negotiated whale deals** (flatter per-MAU rates, longer cycles, handled opportunistically, not pipelined). The global top tier with in-house AI ambitions is excluded outright.

**Sequencing: credibility and velocity run in parallel, not in order.** The pilot proves the product and produces the telemetry. From there, two tracks simultaneously: in India, one recognizable exchange logo pursued deliberately — the reference that makes partners #4–10 easy; in MENA, velocity through Kartik's network, where relationship-driven cycles compress and the second regional pod improves fleet economics by design. The integration-fee waiver for the first three partners is the scarcity mechanism binding both tracks: it gives every early conversation a real, expiring reason to sign now. Among the first three partners, at least one must be a name the industry recognizes; the other two can be pure speed.

**Sales motion: founder-led, discovery-fed.** The willingness-to-pay conversations already planned are the pipeline — every pricing-discovery meeting is a first sales meeting. Two founders sell; the rate card's simplicity (one flat number, no meters) is itself a velocity feature, designed so a founder can close without a sales engineer and a spreadsheet.

**Demand generation: category creation.** The KOL motion's job is bigger than any one partner campaign: it promotes *conversational trading itself as a new way to trade* — content that teaches traders to expect a chat-first trading experience, making "does your exchange have this?" a question venues start hearing from their own users. Category-creation content lifts every partner and costs no partner anything; partner-specific campaigns ("Hippo on [Exchange]") activate post-pilot, once proof metrics exist and the campaign-funding structure is agreed. Sequence: evangelize the category now, monetize the campaigns later.

## 5. Product scope

Hippo v1 does three things, and does them inside one conversation.

**Research.** A trader asks what is happening and why — "why is BTC down today," "any news on MATIC," "what does funding rate mean" — and receives a factual, sourced answer grounded in live market data: price action, news, on-chain activity, market structure. Answers explain; they never recommend. Concept questions get plain-language explanations calibrated to the user's experience level.

**Action.** A trader states an intent — "buy 0.5 BTC at market," "sell half my SOL position" — and Hippo interprets it, prepares the order, and presents a structured confirmation ticket showing exactly what will execute: instrument, side, size, price, fees. Nothing executes without an explicit confirm on that ticket. Execution happens on the partner's rails through their APIs. The same card vocabulary serves open orders, positions, and P&L on request.

**Memory.** Hippo remembers the user across sessions — assets they follow, their experience level, open threads of conversation — so the tenth session starts smarter than the first. Persona, not surveillance: memory personalizes explanation depth and context, never targets or profiles for anything beyond the conversation itself.

**The journey is one loop:** ask → understand → (confirm →) act, with research and action interleaving naturally — a trader reads an explanation of a move, asks what their position looks like, and places an order without leaving the thread.

**What Hippo will not do — product law, not roadmap gap:** no buy/sell recommendations, no signals, no price predictions, no portfolio advice, no "what would you do?" Under the hood this is one guardrail doing three jobs at once: it is the trust position (an agent that never shills is an agent traders believe), the caching economics (factual answers are identical across users, which is what makes flat pricing survivable), and the regulatory line (information, not investment advice — the boundary that keeps Hippo unlicensed and the partner's compliance team calm).

**The "should I buy?" posture.** A large fraction of real queries will ask for advice directly. The v1 posture is decline-and-redirect, as product law: Hippo states plainly that it doesn't advise, then immediately pivots to the factual frame — *"I can't tell you whether to buy, but here's what's happening with SOL right now: [price action, news, funding data]."* The user hits a boundary but never a wall; the conversation continues on the right side of the line. The bake-off's adversarial queries score models against exactly this posture, and consistency under baiting is a launch gate, not a nice-to-have.

**Future product idea — support first-responder (v2, post-pilot).** The same surface and intent engine can answer partner-specific support queries — fees, account processes, product tutorials — from a content corpus the partner pushes through a standard ingestion pipeline, with anything account-specific handing off to human support with context attached. Informational queries only; support interactions do not count toward MAU; priced as a separate flat add-on with refresh-cadence tiers (faster content updates = higher flat fee — steps, not meters, same philosophy as core). Strategically it makes Hippo a strict superset of incumbent support chatbots and deepens partner lock-in. It begins only after the pilot proves the core product; the pilot partner is its natural beta.

Everything else — alerts, watchlists, richer analytics, multi-venue context — is post-pilot roadmap, sequenced by what pilot conversations show traders actually reaching for.

## 6. Regulatory position

Hippo's regulatory strategy is structural: the product is designed so that the licensed activities belong to the partner and the unlicensed ones to us. Two design choices carry the entire position.

**The execution seam.** Every order executes on the partner's rails, through the partner's APIs, under the partner's licenses, KYC, and custody arrangements. Hippo interprets intent and prepares tickets; the partner's systems execute them. We never hold funds, never touch custody, never route an order through our own infrastructure. Regulatory obligations attached to execution — suitability, market conduct, settlement — sit where they already sat before Hippo arrived: with the venue.

**The information line.** Hippo explains markets; it never advises. No recommendations, no signals, no predictions, no portfolio guidance — product law, enforced by the guardrail and continuously tested by the eval harness's adversarial queries. This keeps Hippo on the information side of the information-versus-investment-advice boundary — a line that is not asset-class specific, so the position holds across everything a partner lists. **Our position on this line is validated by counsel** (note to be annexed). Critically, the guardrail is not a policy document — it is a tested, measurable product behavior, which means we can demonstrate enforcement, not merely assert it. Advice-avoidance under baiting is a launch gate with a score attached.

**Data law is answered by architecture.** Partner user data lives in-region, in the partner's regional pod, and never leaves — India data in India, Gulf data in the Gulf. Cross-border data-transfer questions largely dissolve because the transfers don't happen. The anonymized Layer 2 corpus is engineered to be un-linkable to partner PII, which is what lets it move fleet-wide without carrying personal-data obligations along.

**What we track honestly.** The information/advice line is interpreted by regulators, not only drawn by us — which is why enforcement evidence matters as much as the position itself. And MENA entry gets local counsel review before the first Gulf contract is signed, not after; VARA-regulated venues in Dubai will expect vendor diligence, and arriving with our structural answers documented is what keeps that diligence short.

## 7. The AI stack

**We run exclusively on open-source models. No frontier APIs.** This gives us full data sovereignty (nothing leaves infrastructure we control — decisive in partner security reviews), cost control, and independence from external vendors.

The stack is tiered by workload. Small models (7–8B class) handle intent classification, order construction, and user memory — high-volume, latency-critical work these models do well and cheaply. A ~30B-class model handles research and market explanation, the workload where quality is the product.

Our research-model shortlist, all Apache 2.0 licensed:

| Model | Role |
|---|---|
| **Qwen3.6-35B-A3B (MoE)** | Primary candidate. Mixture-of-experts: ~3B active parameters give it the speed of a small model at near-32B quality. Moves node cost and per-node capacity simultaneously. |
| **Qwen3-32B (dense)** | Production reference. Matches last-generation 72B quality; runs on a single H100. |
| **QwQ-32B (reasoning)** | Quality ceiling reference. Top-tier open-model reasoning for finance; slower per answer. |
| **70B-class** | Baseline for comparison only. |

Model selection is decided by evaluation, not reputation. We are running a bake-off: 300 queries mirroring real traffic (market-event explanations, asset research, concept questions, portfolio context, and adversarial advice-baiting — at least a quarter in Hinglish), scored on factual accuracy, advice-avoidance, completeness, latency, and hallucination rate. A 30B model passes if it lands within 5% of the 70B baseline on accuracy and advice-avoidance with no hallucination gap. Research quality is a launch gate: no model ships until it passes.

This exam is not disposable. The query set and rubric become **our eval harness — core IP**. Every future model release re-sits the same exam, which means our costs fall automatically as open models improve, with zero guesswork. Combined with the anonymized conversation data we retain from every partner (see §11), the harness compounds into an asset no host can replicate by hiring engineers: they would need thousands of labeled real trader conversations to know whether their version is any good. We will have them; they won't.

We deliberately rejected finance-specific fine-tunes (FinGPT and similar) — they are older, smaller models built for sentiment scoring, not conversational market explanation. The right architecture is a strong general model over live market-data retrieval. Industry benchmarking is sobering here — even frontier models fail most open-ended financial QA — which is exactly why Hippo's product guardrail matters: we answer *"what happened and why"* with facts; we never give advice. That scope discipline is what makes the quality bar passable, and it produces an unexpected economic advantage described below.

## 8. Infrastructure

**We run on trusted GPU cloud only.** Decentralized GPU marketplaces were evaluated for their cost advantage and rejected: anonymous peer-to-peer hardware cannot survive a partner security review and contradicts the sovereignty position we sell. Production traffic runs on certified cloud regions we select — India for our first partner, Gulf regions as we expand to MENA.

We rent; we do not buy hardware pre-fundraise. Rented capacity keeps us asset-light, and it deflates in downturns — when market activity falls, we release nodes and our cost base follows demand down. Owned hardware becomes a post-fundraise decision, gated on real utilization data including a bear-case scenario.

Capacity runs on a hybrid model: a reserved floor sized for normal traffic, plus a pre-warmed burst layer triggered by market volatility itself. Price moves minutes before the query wave arrives — our monitoring watches the market, not just the load, and warms capacity before users flood in.

## 9. Unit economics

The minimum viable footprint — what we run before serving a single user — is one research node, one small-model node, market data feeds, and monitoring: **roughly ₹2.5–3 lakh per month** on current 30B-class configurations.

Raw, a research node serves 5–8k monthly active users, because we provision for the worst fifteen minutes of the month, not the average. **Caching changes this arithmetic fundamentally.** When the market moves sharply, thousands of users ask the same question within minutes. Because our answers are factual — not personalized opinions — the market-level explanation is generated once and served fleet-wide; only a thin personalization layer runs per user. Correlated demand spikes, the nightmare of every infrastructure plan, become our cheapest traffic. Caching-adjusted, one research node serves **~30,000 MAU**, and our at-scale cost floor lands at **₹10–18 per MAU**, likely lower on MoE economics.

This is the core insight of our cost structure: the product guardrail (facts only, no advice) is also the unit-economics engine. It cannot be copied from our pricing page — a competitor offering personalized takes cannot cache them.

Four levers drive our costs down over time: **model routing** (the eval harness continuously re-decides how small we can go), **GPU cost and throughput** (commercial negotiation and engineering efficiency respectively), **fleet architecture** (see §12), and **caching** (the multiplier on all three).

## 10. Pricing

**One revenue stream: an MAU-linked flat fee.** No query metering, no per-use charges, no performance clauses. Exchange CFOs can forecast their active-user count; they cannot forecast query volume, and an unpredictable bill is how vendors get cancelled. We absorb usage variance because our architecture is specifically built to make it cheap — flat pricing on spiky GPU workloads is only survivable with our caching layer, which makes the pricing model itself evidence of the moat.

**The rate card:**

| Tier | Monthly fee |
|---|---|
| Up to 10,000 MAU | **₹5,00,000** |
| Up to 25,000 MAU | **₹7,50,000** |

Higher tiers (50K/75K/100K MAU at ₹10L/₹15L/₹17.5L) exist as an internal ladder and are quoted on request; they publish once pilot telemetry validates node capacity at scale. We never defend a number we haven't validated. The ladder holds a healthy margin at every tier — richest at the entry tiers by design — and the per-MAU rate falls with scale, which is the partner-facing volume story. Pricing beyond 100K MAU is negotiated per-deal.

**An MAU is a user who received at least one research answer or executed at least one order through Hippo in the calendar month.** Both are unambiguous, logged events; balance checks and small talk are free. Tier crossings work on a trailing 3-month average with a 10% grace band — upgrades apply from the following month with notice, downgrades happen on request. The ladder works in both directions; in a bear market, stepping down a tier is how a partner stays a partner.

**Integration fee: ₹2 lakh**, on the rate card from day one — and visibly waived for our first three partners. The fee exists permanently; the waiver is the launch concession. This shields the monthly ladder from discount pressure.

A fair-use clause protects the fleet without metering anyone: if a partner's trailing-quarter query rate exceeds three times the fleet-wide average, we review tier fit together. It targets anomalies — bots, abuse — never enthusiasm, and it never generates a charge.

Deliberately absent from this model: performance-linked pricing. We designed and stress-tested a volume-lift revenue share and an acquisition bounty, and archived both. They reintroduce attribution complexity, negotiation surface, and billing disputes that a company at our stage should not carry. The pilot instruments the lift data anyway — as fundraise evidence and sales narrative, not as a billing input. If the evidence ever justifies reopening performance pricing for later partners, the design work is done and filed.

## 11. Contract standards

- **Term:** 12-month initial term, annual renewal. Material-breach exit both ways; 60–90 day non-renewal notice.
- **SLA:** 99.5% monthly uptime, service credits as remedy. We commit contractually to **graceful degradation**: during extreme market events, research answers may slow, but intent recognition, order flow, and cached market explanations stay responsive. Competitors without a cache layer cannot sign that sentence. Numeric latency SLAs are deferred to first renewal, when we have production data to underwrite them.
- **Data rights — three layers:**
  - **Layer 1 — Partner user data** (PII, accounts, balances, orders): the partner's property, processed only to serve their users, resident in-region, deleted on exit.
  - **Layer 2 — Anonymized conversation logs:** Hippo retains and uses these for evals, caching, and model improvement, across partners, surviving contract exit. Un-linkable to partner PII. **This layer is non-negotiable — a partner who refuses it is a partner we don't sign.** It is what feeds the eval harness and the data moat.
  - **Layer 3 — Derived intelligence** (models, eval sets, caches, aggregate insights): Hippo IP outright.
  - Each partner receives an aggregate insights report from their own anonymized data — usage patterns, top-queried assets, engagement trends — making Layer 2 an exchange of value, not a taking.

## 12. Economics at fleet scale

The endgame is a pooled fleet serving many exchanges, run with yield-management discipline. Individually provisioned partners each pay the peak-capacity tax; pooled, one partner's quiet hours absorb another's busy ones, cutting total nodes needed by 40–60%. Time-zone spread flattens the load curve further — an economic argument for adding a non-Indian venue early.

Crypto's correlated spikes would normally defeat pooling — when BTC crashes, it crashes for everyone. Our caching inverts this: correlated demand means identical questions, and identical questions are served fleet-wide from one generation. Uncorrelated traffic multiplexes; correlated traffic caches. The fleet is hedged from both directions.

User-context workloads stay in regional pods for data residency; the market-level research and cache tier — which carries no user data by design — runs as one global shared layer. We pool where pooling pays and localize where sovereignty demands.

Partners see none of this. They see a flat fee and a responsive product. Pooling gains are our margin expansion: each marginal partner onboards onto existing headroom at near-zero incremental cost while paying a full fee. That is where this business earns software margins despite running GPUs. Our core internal KPI is fleet utilization, targeted at 60–75% sustained; utilization telemetry is the sole trigger for capacity expansion.

## 13. Team

**Ram** — strategy and brand. Senior leadership background at CoinDCX, where he ran brand and growth at India's largest crypto exchange; carries the firsthand market intuition behind our pricing anchors and partner psychology.

**Sudha** — data and trust. Owns instrumentation, the eval harness, and the trust layer — the telemetry and measurement discipline this memo repeatedly leans on; also drives product definition.

**Victor** — product. Leads the conversational experience and the SDK: the intent engine, the card vocabulary, and the thin-client surface partners embed.

**Kartik** — commercial. Investor and partner relationships; India-based with deep MENA networks, which anchors both the regional expansion track and the fundraise motion.

## 14. What we are validating now

Every number above is either locked or has a named validation path:

| Workstream | Owner | Outcome |
|---|---|---|
| Model bake-off (spec final, ~2 weeks) | Victor + Sudha | Selects the research model; confirms the footprint and ladder margins; stands up eval harness v1 |
| India + Gulf GPU quotes (3–4 providers/region) | Kartik | Replaces global rate assumptions with regional reality; re-verifies tier margins |
| Feeds conversation with the pilot partner | Ram | What market data do they pipe free — swings the footprint ₹0.4–0.8L |
| 100K+ MAU pricing discovery | Kartik | Whale-tier structure for CoinDCX-scale partners |
| Pilot instrumentation | Sudha | Load curves, cache hit rate (the number that underwrites the rate card), queries/MAU distribution, true cost/MAU, and lift telemetry for the fundraise |

The pilot is where estimates become measurements. The rate card's entry tiers are profitable under every scenario; the pilot's telemetry determines how fast we release the rest of the ladder.

---

*Hippo App: one product, one revenue stream, four cost levers, and an eval harness that compounds. Focus is the constraint.*
