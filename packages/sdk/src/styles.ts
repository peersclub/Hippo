/**
 * Panel styles — Dark Glass Instrument, fully token-driven.
 * Injected as a constructable stylesheet into the closed shadow root.
 *
 * Every colour, font and the pill radius resolve through `--hippo-*` custom
 * properties declared on `:host`. Dark is the locked hero; the
 * `:host([data-theme="light"])` block is a PURE token swap (it redeclares
 * tokens only — no layout, no new properties), so switching themes never
 * touches a single rule in the body below. The dark token values equal the
 * literals they replaced 1:1, so the dark rendering is pixel-identical.
 *
 * Hard rule: solid card backgrounds inside the scroll container;
 * backdrop-filter is reserved for full-surface overlays only (iOS/WebKit).
 *
 * Token naming mirrors the brand core at
 * Hippo/Reference/brand/hippo-tokens.css (the SDK set is the superset).
 */
export const panelCss = /* css */ `
:host{all:initial;
  /* ── surfaces ── */
  --hippo-panel-top:#15171D;--hippo-panel-bottom:#101217;--hippo-panel:#14161C;
  --hippo-card:#232733;--hippo-card-2:#262B36;--hippo-user-bubble:#2A2E38;
  --hippo-skeleton-1:#2A2F3B;--hippo-skeleton-2:#353B49;
  /* ── accent (the single brand accent) ── */
  --hippo-amber:#F0B94A;--hippo-amber-ink:#15171D;--hippo-amber-tint:#E8CE93;
  /* ── semantic status (NOT brand accents) ── */
  --hippo-up:#2EC48D;--hippo-down:#FF8585;
  /* ── text tiers ── */
  --hippo-text-hi:#E9EBF0;--hippo-text-mid:#B8BDC9;--hippo-text-dim:#8A8F9C;
  --hippo-text-faint:#6A7080;--hippo-text-dim-2:#9BA1AE;
  /* ── rgb triplets, for tinted fills / borders / shadows ── */
  --hippo-amber-rgb:240,185,74;--hippo-up-rgb:46,196,141;--hippo-down-rgb:255,133,133;
  --hippo-white-rgb:255,255,255;--hippo-black-rgb:0,0,0;--hippo-bg-rgb:14,16,20;
  --hippo-panel-deep-rgb:20,22,28;--hippo-surface-rgb:38,42,52;
  /* ── lines ── */
  --hippo-hairline:rgba(255,255,255,.07);
  /* ── type ── */
  --hippo-font-display:'Outfit',system-ui,sans-serif;
  --hippo-font-body:'Inter',system-ui,sans-serif;
  --hippo-font-mono:'IBM Plex Mono',ui-monospace,monospace;
  /* ── radius ── */
  --hippo-radius-card:16px;--hippo-radius-cell:10px;--hippo-radius-button:12px;--hippo-radius-pill:999px}
*{margin:0;padding:0;box-sizing:border-box}
/* Logical inset/border properties so dir="rtl" mirrors the dock to the
   opposite edge automatically (RTL groundwork for the Gulf market). In LTR
   these resolve exactly as the previous right/left/border-left rules did. */
.panel{position:fixed;inset-inline-end:0;inset-block:0;width:360px;z-index:2147483001;
  background:linear-gradient(175deg,var(--hippo-panel-top),var(--hippo-panel-bottom));border-inline-start:1px solid var(--hippo-hairline);
  display:flex;flex-direction:column;color:var(--hippo-text-hi);
  font-family:var(--hippo-font-body);font-size:14px}
.panel.max{width:620px;box-shadow:-30px 0 60px rgba(var(--hippo-black-rgb),.45);border-inline-start-color:rgba(var(--hippo-amber-rgb),.25)}
.panel.hidden{display:none}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
/* ── posture matrix ── client presentation only; dock is the default (base
   .panel above). Non-dock postures are additive overrides, so the dock/dark
   rendering the server sees is unchanged. */
.panel.overlay{inset-block-start:auto;inset-block-end:22px;inset-inline-start:auto;inset-inline-end:22px;width:380px;height:min(760px,88vh);
  border:1px solid var(--hippo-hairline);border-radius:var(--hippo-radius-card);
  box-shadow:0 30px 80px rgba(var(--hippo-black-rgb),.55);overflow:hidden}
.panel.sheet{inset-block-start:auto;inset-block-end:0;inset-inline:0;width:100%;height:min(84vh,760px);
  border-inline-start:none;border-top:1px solid var(--hippo-hairline);border-radius:18px 18px 0 0;
  box-shadow:0 -24px 60px rgba(var(--hippo-black-rgb),.5);animation:sheetIn .28s ease both}
.panel.full{inset:0;width:100%;border-inline-start:none;border-radius:0}
@keyframes sheetIn{from{transform:translateY(100%)}to{transform:none}}
@media (prefers-reduced-motion:reduce){.panel.sheet{animation:none}}
/* narrow viewport safety net: web geometry collapses into the mobile set */
@media (max-width:640px){
  .panel,.panel.max{width:100%;border-inline-start:none}
  .panel.overlay{inset:0;width:100%;height:100%;border:none;border-radius:0}
}
/* header */
.hd{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--hippo-hairline);flex-shrink:0}
.hd .mark{width:24px;height:24px;border-radius:8px;background:var(--hippo-amber);color:var(--hippo-amber-ink);
  display:grid;place-items:center;font-family:var(--hippo-font-display);font-weight:700;font-size:12px}
.hd .name{font-family:var(--hippo-font-display);font-weight:600;font-size:13.5px}
.hd .name small{display:block;font-family:var(--hippo-font-mono);font-weight:400;font-size:8.5px;letter-spacing:.12em;color:var(--hippo-text-faint);margin-top:1px}
.hd .ctl{margin-inline-start:auto;display:flex;gap:6px}
.hd .ctl button{width:26px;height:26px;border-radius:8px;border:1px solid var(--hippo-hairline);
  background:rgba(var(--hippo-white-rgb),.03);color:var(--hippo-text-dim);font-size:12px;display:grid;place-items:center}
.hd .ctl button:hover{color:var(--hippo-text-hi);border-color:rgba(var(--hippo-white-rgb),.18)}
.hd .ctl button:focus-visible{outline:2px solid var(--hippo-amber);outline-offset:1px}
/* orders strip */
.orders{flex-shrink:0;padding:9px 13px 10px;border-bottom:1px solid var(--hippo-hairline);background:rgba(var(--hippo-panel-deep-rgb),.4)}
.orders .lab{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.14em;color:var(--hippo-text-faint);
  margin-bottom:7px;display:flex;justify-content:space-between}
.orders .lab .cnt{color:var(--hippo-amber)}
.orders .row{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none}
.orders .row::-webkit-scrollbar{display:none}
.opill{flex-shrink:0;display:flex;align-items:center;gap:7px;background:rgba(var(--hippo-surface-rgb),.6);
  border:1px solid var(--hippo-hairline);border-radius:var(--hippo-radius-pill);padding:7px 12px;
  font-family:var(--hippo-font-mono);font-size:10.5px;color:var(--hippo-text-hi);white-space:nowrap}
.opill .sd{width:6px;height:6px;border-radius:50%}
.opill.buy .sd{background:var(--hippo-up)}.opill.sell .sd{background:var(--hippo-down)}
.opill .st{color:var(--hippo-text-faint);font-size:9px}
.opill.new{border:1px dashed rgba(var(--hippo-amber-rgb),.5);color:var(--hippo-amber);font-family:var(--hippo-font-display);font-weight:600;font-size:11px}
.opill.on{border-color:rgba(var(--hippo-amber-rgb),.6);background:rgba(var(--hippo-amber-rgb),.08)}
.opill:focus-visible{outline:2px solid var(--hippo-amber);outline-offset:1px}
/* order pill expand — in place below the strip, max-height animated (§3) */
.oexp{overflow:hidden;max-height:0;transition:max-height .28s ease}
.oexp.open{max-height:240px}
@media (prefers-reduced-motion:reduce){.oexp{transition:none}}
.ocard{margin-top:9px;background:var(--hippo-card);border:1px solid rgba(var(--hippo-white-rgb),.08);border-radius:13px;
  padding:11px 12px;display:flex;flex-direction:column;gap:8px}
.ocard .och{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.oside{font-family:var(--hippo-font-mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;padding:3px 8px;border-radius:var(--hippo-radius-pill)}
.oside.buy{background:rgba(var(--hippo-up-rgb),.12);color:var(--hippo-up)}
.oside.sell{background:rgba(var(--hippo-down-rgb),.12);color:var(--hippo-down)}
.ocard .osum{font-family:var(--hippo-font-mono);font-weight:500;font-size:11.5px}
.ocard .odet{font-family:var(--hippo-font-mono);font-size:9px;color:var(--hippo-text-dim);border:1px solid var(--hippo-hairline);border-radius:var(--hippo-radius-pill);padding:2px 7px}
.ocard .ostat{font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.12em;color:var(--hippo-amber)}
.omanage{font-family:var(--hippo-font-display);font-weight:600;font-size:11.5px;text-align:center;padding:9px 12px;
  border:1px solid var(--hippo-hairline);border-radius:10px;background:rgba(var(--hippo-panel-deep-rgb),.7);color:var(--hippo-text-hi)}
.omanage:hover{border-color:rgba(var(--hippo-amber-rgb),.4)}
/* + New order hint — conversational, never a form */
.newhint{margin-top:9px;border:1px dashed rgba(var(--hippo-amber-rgb),.5);border-radius:13px;padding:11px 12px}
.newhint b{display:block;font-family:var(--hippo-font-display);font-weight:600;font-size:12px;color:var(--hippo-amber);margin-bottom:8px}
.nchips{display:flex;gap:7px;flex-wrap:wrap}
/* thread — wrapped so the jump pill can float over the scroll area */
.threadwrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.thread{overflow-y:auto;padding:13px;display:flex;flex-direction:column;gap:11px;flex:1;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain}
/* jump-to-latest — appears only when the trader scrolled up and new content landed */
.jump{position:absolute;inset-block-end:12px;inset-inline-end:14px;font-family:var(--hippo-font-mono);
  font-size:9px;letter-spacing:.1em;color:var(--hippo-amber-ink);background:var(--hippo-amber);
  border-radius:var(--hippo-radius-pill);padding:6px 11px;box-shadow:0 6px 18px rgba(var(--hippo-black-rgb),.35);
  animation:msgIn .25s ease both}
@media (prefers-reduced-motion:reduce){.jump{animation:none}}
.thread>*{flex-shrink:0;animation:msgIn .3s ease both}
@media (prefers-reduced-motion:reduce){.thread>*{animation:none}}
@keyframes msgIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.umsg{align-self:flex-end;max-width:80%;font-size:12.5px;line-height:1.45;padding:9px 13px;
  border-radius:14px 14px 5px 14px;background:var(--hippo-user-bubble);border:1px solid var(--hippo-hairline)}
.bubble{align-self:flex-start;max-width:96%;border-radius:15px;padding:13px;background:var(--hippo-card);border:1px solid rgba(var(--hippo-white-rgb),.08)}
.eyebrow{font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.14em;margin-bottom:7px;display:flex;justify-content:space-between;color:var(--hippo-text-dim)}
.eyebrow .live{color:var(--hippo-amber)}
.eyebrow-right{display:flex;align-items:center;gap:8px}
.model-tag{font-family:var(--hippo-font-mono);font-size:8px;letter-spacing:.04em;color:var(--hippo-text-faint);text-transform:none}
.bubble h3{font-family:var(--hippo-font-display);font-size:15px;font-weight:600;margin-bottom:5px}
.bubble p{font-size:12.5px;line-height:1.58;color:var(--hippo-text-mid)}
.bubble p+p{margin-top:6px}
.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:10px 0 3px}
.kv div{border-radius:9px;padding:7px 8px;background:rgba(var(--hippo-panel-deep-rgb),.7);border:1px solid var(--hippo-hairline)}
.kv .k{font-family:var(--hippo-font-mono);font-size:8px;letter-spacing:.12em;display:block;margin-bottom:3px;color:var(--hippo-text-faint)}
.kv .v{font-family:var(--hippo-font-mono);font-size:11.5px;font-weight:500}
.kv .v.neg{color:var(--hippo-down)}.kv .v.pos{color:var(--hippo-up)}
svg.spark{display:block;width:100%;height:48px;margin-top:7px}
.spark .line{stroke:var(--hippo-amber);fill:none;stroke-width:1.5;stroke-linecap:round}
.spark .fill{fill:rgba(var(--hippo-amber-rgb),.07)}
.figcap{font-family:var(--hippo-font-mono);font-size:9px;display:flex;justify-content:space-between;margin-top:4px;color:var(--hippo-text-faint)}
.srcs{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
.src{font-family:var(--hippo-font-mono);font-size:9px;padding:3px 8px;border-radius:var(--hippo-radius-pill);background:rgba(var(--hippo-white-rgb),.06);color:var(--hippo-text-dim-2)}
/* live bar */
.livebar{display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:9px;
  border-top:1px dashed rgba(var(--hippo-white-rgb),.08);font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.1em}
.livebar .asof{color:var(--hippo-text-faint);margin-inline-end:auto;transition:color .3s}
.livebar .asof.flash{color:var(--hippo-amber)}
.livebar button{color:var(--hippo-text-dim-2);font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.1em;padding:2px 0}
.livebar button:hover{color:var(--hippo-amber)}
/* stale data — declared, never silent: as-of turns amber, REFRESH gets loud */
.livebar.stale .asof{color:var(--hippo-amber)}
.livebar.stale .rf{background:var(--hippo-amber);color:var(--hippo-amber-ink);font-weight:600;padding:4px 9px;border-radius:var(--hippo-radius-pill)}
.livebar.stale .rf:hover{color:var(--hippo-amber-ink)}
.fb{display:flex;gap:7px;align-items:center}
.fb button{font-size:12px;filter:grayscale(1);opacity:.5}
.fb button:hover{opacity:.95}
.fb .done{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.1em;color:var(--hippo-amber)}
/* 👎 follow-up — one line in the live-bar area; reasons map 1:1 to eval criteria */
.fbask{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;
  font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.08em}
.fbask .q{color:var(--hippo-text-faint)}
.fbchip{border:1px solid var(--hippo-hairline);border-radius:var(--hippo-radius-pill);padding:3px 9px;background:rgba(var(--hippo-white-rgb),.04);
  font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.05em;color:var(--hippo-text-mid)}
.fbchip:hover{border-color:rgba(var(--hippo-amber-rgb),.4);color:var(--hippo-text-hi)}
.fbskip{margin-inline-start:auto;font-family:var(--hippo-font-mono);font-size:8.5px;color:var(--hippo-text-faint);padding:2px 0}
.fbskip:hover{color:var(--hippo-text-hi)}
.cache-badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--hippo-font-mono);font-size:8px;
  letter-spacing:.12em;color:var(--hippo-amber);background:rgba(var(--hippo-amber-rgb),.1);border-radius:var(--hippo-radius-pill);padding:3px 8px;margin-bottom:8px}
/* ticket */
.ticket{align-self:flex-start;width:94%;border-radius:var(--hippo-radius-card);overflow:hidden;background:var(--hippo-card-2);border:1px solid rgba(var(--hippo-amber-rgb),.35)}
.ticket .th{display:flex;justify-content:space-between;align-items:center;padding:11px 13px;border-bottom:1px solid var(--hippo-hairline)}
.ticket .tt{font-family:var(--hippo-font-display);font-weight:600;font-size:13px}
.ticket .side{font-family:var(--hippo-font-mono);font-size:10px;font-weight:600;letter-spacing:.06em;padding:3px 9px;border-radius:var(--hippo-radius-pill)}
.ticket .side.buy{background:rgba(var(--hippo-up-rgb),.12);color:var(--hippo-up)}
.ticket .side.sell{background:rgba(var(--hippo-down-rgb),.12);color:var(--hippo-down)}
.ticket .tb{padding:2px 13px 3px}
.trow{display:flex;justify-content:space-between;padding:7px 0;font-size:12.5px}
.trow+.trow{border-top:1px dashed rgba(var(--hippo-white-rgb),.09)}
.trow .lab{font-size:10.5px;align-self:center;color:var(--hippo-text-dim)}
.trow b{font-family:var(--hippo-font-mono);font-weight:500;font-size:11.5px}
.cta{display:block;width:calc(100% - 26px);margin:9px 13px 11px;font-family:var(--hippo-font-display);font-weight:600;
  font-size:12.5px;padding:12px;border-radius:11px;background:var(--hippo-amber);color:var(--hippo-amber-ink);text-align:center}
.tfoot{font-size:9.5px;text-align:center;padding:0 13px 11px;line-height:1.5;color:var(--hippo-text-faint)}
.action-failed{font-family:var(--hippo-font-mono);font-size:10px;text-align:center;padding:0 13px 9px;color:var(--hippo-down)}
/* lifecycle */
.await{display:flex;align-items:center;gap:8px;padding:10px 13px;border-top:1px dashed rgba(var(--hippo-white-rgb),.09);
  font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.1em;color:var(--hippo-amber)}
.await .pulse{width:7px;height:7px;border-radius:50%;background:var(--hippo-amber);animation:hpulse 1.2s ease infinite}
@keyframes hpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}
.await .cxl{margin-inline-start:auto;color:var(--hippo-text-faint);font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.1em}
.await .cxl:hover{color:var(--hippo-down)}
.ticket.ok{border-color:rgba(var(--hippo-up-rgb),.45)}
.oid{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.1em;color:var(--hippo-text-faint);text-align:center;padding-bottom:11px}
/* decline */
.decline{align-self:flex-start;max-width:94%;border-radius:15px;overflow:hidden;background:var(--hippo-card);
  border:1px solid rgba(var(--hippo-white-rgb),.08);border-left:3px solid var(--hippo-amber)}
.decline .dchead{padding:10px 13px 0}
.dcbadge{display:inline-flex;gap:5px;font-family:var(--hippo-font-mono);font-size:8px;letter-spacing:.14em;color:var(--hippo-amber);
  background:rgba(var(--hippo-amber-rgb),.1);border-radius:var(--hippo-radius-pill);padding:3px 9px}
.decline .body{padding:9px 13px 12px}
.decline .body>p{font-size:12.5px;line-height:1.58;color:var(--hippo-text-mid)}
.decline .pivot{font-family:var(--hippo-font-display);font-weight:600;font-size:12.5px;color:var(--hippo-text-hi);margin:10px 0 8px}
.facts{display:flex;flex-direction:column;gap:6px}
.fact{display:flex;gap:9px;font-size:12px;line-height:1.5;color:var(--hippo-text-mid);background:rgba(var(--hippo-panel-deep-rgb),.6);
  border:1px solid var(--hippo-hairline);border-radius:10px;padding:8px 11px}
.fact .fi{color:var(--hippo-amber);flex-shrink:0;font-size:11px}
/* thinking / skeleton */
.think{display:flex;align-items:center;gap:8px;font-family:var(--hippo-font-mono);font-size:9.5px;letter-spacing:.12em;color:var(--hippo-text-dim)}
.think .dot{width:7px;height:7px;border-radius:50%;background:var(--hippo-amber);animation:hpulse 1.1s ease infinite}
.sk{background:linear-gradient(90deg,var(--hippo-skeleton-1) 25%,var(--hippo-skeleton-2) 37%,var(--hippo-skeleton-1) 63%);background-size:400% 100%;
  animation:shim 1.2s linear infinite;border-radius:6px}
@keyframes shim{0%{background-position:100% 0}100%{background-position:0 0}}
.sk-title{height:13px;width:70%;margin-bottom:9px}.sk-line{height:9px;width:100%;margin-bottom:6px}
.sk-line.short{width:55%}
.sk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:10px}
.sk-cell{height:38px;border-radius:9px}
/* streaming brief prose (brief_delta) */
.stream-text{white-space:pre-wrap}
.stream-cursor{display:inline-block;width:7px;height:12px;margin-left:2px;vertical-align:-1px;
  background:var(--hippo-amber);animation:hpulse 1.1s ease infinite}
/* stalled stream, finalized by the watchdog — honest, never a dead cursor */
.stream-cut{margin-top:9px;padding-top:9px;border-top:1px dashed rgba(var(--hippo-white-rgb),.08);
  font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.06em;line-height:1.5;color:var(--hippo-text-faint)}
/* REFRESH held pending until the replacing brief lands (never a fixed flash) */
.livebar .rf.pending{opacity:.6;cursor:default}
.livebar.stale .rf.pending{opacity:.75}
/* positions */
.pos-row{display:flex;justify-content:space-between;gap:8px;padding:8px 0;font-family:var(--hippo-font-mono);font-size:11px}
.pos-row+.pos-row{border-top:1px dashed rgba(var(--hippo-white-rgb),.09)}
.pos-row .neg{color:var(--hippo-down)}.pos-row .pos{color:var(--hippo-up)}
/* banner */
.banner{display:flex;gap:9px;padding:10px 13px;font-size:11px;line-height:1.5;border-radius:12px}
.banner.degraded{background:rgba(var(--hippo-amber-rgb),.1);border:1px solid rgba(var(--hippo-amber-rgb),.3);color:var(--hippo-amber-tint)}
.banner.offline,.banner.info{background:rgba(var(--hippo-white-rgb),.05);border:1px solid var(--hippo-hairline);color:var(--hippo-text-dim-2)}
.banner b{font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.12em;display:block;margin-bottom:2px}
/* pinned banners — above the orders strip, never scroll away */
.pins{flex-shrink:0;display:flex;flex-direction:column;gap:7px;padding:9px 13px 0}
/* empty thread — never blank */
.empty{margin:auto;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:20px 8px}
.empty .emark{width:40px;height:40px;border-radius:13px;background:var(--hippo-amber);color:var(--hippo-amber-ink);
  display:grid;place-items:center;font-family:var(--hippo-font-display);font-weight:700;font-size:18px}
.empty h2{font-family:var(--hippo-font-display);font-size:16.5px;font-weight:600}
.echips{display:flex;flex-direction:column;gap:7px}
/* chips + composer */
.chips{flex-shrink:0;padding:9px 13px 2px;display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;border-top:1px solid var(--hippo-hairline)}
.chips::-webkit-scrollbar{display:none}
.chip{flex-shrink:0;background:rgba(var(--hippo-white-rgb),.04);border:1px solid var(--hippo-hairline);border-radius:var(--hippo-radius-pill);
  padding:7px 13px;font-size:11px;color:var(--hippo-text-mid);white-space:nowrap;
  user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.chip:hover{border-color:rgba(var(--hippo-amber-rgb),.4);color:var(--hippo-text-hi)}
.cwrap{flex-shrink:0}
.sendfail{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.1em;color:var(--hippo-amber);padding:8px 15px 0}
/* queued uplinks — one quiet ambient row, flushed on reconnect */
.qrow{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.1em;color:var(--hippo-amber);padding:8px 15px 0}
/* character counter — invisible until the trader nears the protocol limit */
.ccount{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.08em;color:var(--hippo-text-faint);
  padding:6px 15px 0;text-align:end}
.ccount.max{color:var(--hippo-amber)}
.composer{display:flex;align-items:flex-end;gap:8px;padding:8px 13px 13px;flex-shrink:0}
.composer textarea{flex:1;font-family:var(--hippo-font-body);font-size:12px;line-height:1.45;padding:10px 13px;border-radius:16px;
  background:rgba(var(--hippo-surface-rgb),.7);border:1px solid var(--hippo-hairline);color:var(--hippo-text-hi);outline:none;
  resize:none;max-height:96px;overflow-y:auto}
.composer textarea:focus{border-color:rgba(var(--hippo-amber-rgb),.5)}
.composer textarea::placeholder{color:var(--hippo-text-faint)}
/* offline — composer locks with a reason; typed text is kept, never cleared */
.composer textarea:disabled{opacity:.55}
.composer textarea:disabled::placeholder{font-style:italic}
.composer .send:disabled{opacity:.4;cursor:default}
.composer .send{width:33px;height:33px;border-radius:11px;display:grid;place-items:center;
  font-size:14px;flex-shrink:0;background:var(--hippo-amber);color:var(--hippo-amber-ink)}
/* disabled trading actions fail loud, never silent */
.cta:disabled{opacity:.45;cursor:default}
.await .cxl:disabled{opacity:.45;cursor:default}
/* fallback */
.fallback{align-self:flex-start;max-width:94%;border-radius:15px;padding:12px 13px;
  background:var(--hippo-card);border:1px dashed rgba(var(--hippo-white-rgb),.18)}
.fallback p{font-size:12.5px;line-height:1.55;color:var(--hippo-text-mid)}
.fallback a{color:var(--hippo-amber)}
/* full-surface overlays — the ONLY place backdrop-filter is allowed */
.overlay{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(var(--hippo-bg-rgb),.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  animation:ovIn .25s ease both}
@keyframes ovIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.overlay{animation:none}}
.confetti{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
/* onboarding */
.obcard{position:relative;width:100%;max-width:320px;background:var(--hippo-panel);border:1px solid var(--hippo-hairline);
  border-radius:18px;padding:26px 22px 16px;text-align:center;display:flex;flex-direction:column;gap:12px;
  box-shadow:0 24px 60px rgba(var(--hippo-black-rgb),.5)}
.obeyebrow{font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.22em;color:var(--hippo-amber)}
.obcard h2{font-family:var(--hippo-font-display);font-size:21px;font-weight:600;line-height:1.25}
.obcard>p{font-size:12.5px;line-height:1.6;color:var(--hippo-text-mid)}
.obmark{width:44px;height:44px;margin:0 auto;border-radius:14px;background:var(--hippo-amber);color:var(--hippo-amber-ink);
  display:grid;place-items:center;font-family:var(--hippo-font-display);font-weight:700;font-size:20px;
  box-shadow:0 0 34px rgba(var(--hippo-amber-rgb),.35)}
.tybar{display:flex;align-items:center;gap:2px;justify-content:center;min-height:38px;padding:10px 14px;
  border-radius:var(--hippo-radius-pill);background:rgba(var(--hippo-surface-rgb),.9);border:1px solid rgba(var(--hippo-amber-rgb),.45);
  box-shadow:0 0 22px rgba(var(--hippo-amber-rgb),.18);font-family:var(--hippo-font-mono);font-size:11px;color:var(--hippo-text-hi);
  white-space:nowrap;overflow:hidden}
.tybar .caret{flex-shrink:0;width:7px;height:14px;background:var(--hippo-amber);animation:tyblink 1s steps(1) infinite}
@keyframes tyblink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.tybar .caret{animation:none}}
.obrows{display:flex;flex-direction:column;gap:8px;text-align:left}
.obrow{display:flex;gap:10px;align-items:flex-start;background:rgba(var(--hippo-panel-deep-rgb),.7);
  border:1px solid var(--hippo-hairline);border-radius:12px;padding:11px 12px}
.obrow .obicon{flex-shrink:0;font-size:13px;color:var(--hippo-amber)}
.obrow>div{flex:1}
.obrow b{display:block;font-family:var(--hippo-font-display);font-weight:600;font-size:12px;margin-bottom:2px}
.obrow p{font-size:10.5px;line-height:1.5;color:var(--hippo-text-dim)}
.obcheck{flex-shrink:0;accent-color:var(--hippo-amber);width:15px;height:15px;margin-top:2px}
.tgl{flex-shrink:0;width:34px;height:20px;border-radius:var(--hippo-radius-pill);background:rgba(var(--hippo-white-rgb),.14);
  position:relative;transition:background .2s;padding:0}
.tgl .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--hippo-text-hi);transition:transform .2s}
.tgl.on{background:var(--hippo-amber)}
.tgl.on .knob{transform:translateX(14px);background:var(--hippo-amber-ink)}
.tgl:focus-visible{outline:2px solid var(--hippo-amber);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.tgl,.tgl .knob{transition:none}}
.obcta{font-family:var(--hippo-font-display);font-weight:600;font-size:12.5px;padding:12px;border-radius:11px;
  background:var(--hippo-amber);color:var(--hippo-amber-ink);margin-top:2px}
.obcta:focus-visible{outline:2px solid var(--hippo-text-hi);outline-offset:2px}
.obdots{display:flex;gap:6px;justify-content:center;padding-top:2px}
.obdots span{width:6px;height:6px;border-radius:50%;background:rgba(var(--hippo-white-rgb),.18)}
.obdots span.on{background:var(--hippo-amber)}
.obnotnow{font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.12em;color:var(--hippo-text-faint);padding:4px}
.obnotnow:hover{color:var(--hippo-text-hi)}
/* share overlay — the live, co-branded card (baseline §6) */
.shrcard{position:relative;width:100%;max-width:320px;background:var(--hippo-panel);border:1px solid rgba(var(--hippo-amber-rgb),.35);
  border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 24px 60px rgba(var(--hippo-black-rgb),.5)}
.shrbrand{display:flex;align-items:center;gap:7px;padding-right:28px}
.shrmark{width:20px;height:20px;border-radius:7px;background:var(--hippo-amber);color:var(--hippo-amber-ink);
  display:grid;place-items:center;font-family:var(--hippo-font-display);font-weight:700;font-size:10px}
.shrbrand b{font-family:var(--hippo-font-display);font-size:12.5px;font-weight:600}
.shrbrand .on{color:var(--hippo-text-dim);font-size:11px}
.shrlive{margin-inline-start:auto;font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.12em;color:var(--hippo-up)}
.shrcard h3{font-family:var(--hippo-font-display);font-size:15px;font-weight:600;line-height:1.3}
.shrcard p{font-size:12px;line-height:1.55;color:var(--hippo-text-mid)}
.shrfoot{display:flex;justify-content:space-between;gap:8px;font-family:var(--hippo-font-mono);font-size:8.5px;
  letter-spacing:.1em;color:var(--hippo-text-faint)}
.shrfoot .lnk{color:var(--hippo-amber)}
/* The printed advice-line disclaimer — part of the card, not chrome */
.shrdisc{font-family:var(--hippo-font-mono);font-size:8px;letter-spacing:.16em;color:var(--hippo-text-dim);text-align:center;
  border-top:1px dashed rgba(var(--hippo-white-rgb),.08);padding-top:9px}
.shrx{position:absolute;top:10px;right:10px;width:24px;height:24px;border-radius:8px;
  border:1px solid var(--hippo-hairline);color:var(--hippo-text-dim);display:grid;place-items:center;font-size:10px}
.shrx:hover{color:var(--hippo-text-hi)}
/* settings sheet */
.obcard.sheet{text-align:left;padding-top:18px}
.shhd{display:flex;justify-content:space-between;align-items:center}
.shhd b{font-family:var(--hippo-font-mono);font-size:9.5px;letter-spacing:.16em;color:var(--hippo-text-dim)}
.shhd button{width:24px;height:24px;border-radius:8px;border:1px solid var(--hippo-hairline);color:var(--hippo-text-dim);
  display:grid;place-items:center;font-size:10px}
.shhd button:hover{color:var(--hippo-text-hi)}
.shitem{font-family:var(--hippo-font-display);font-weight:600;font-size:12px;text-align:left;padding:11px 12px;
  border:1px solid var(--hippo-hairline);border-radius:12px;background:rgba(var(--hippo-panel-deep-rgb),.7);color:var(--hippo-text-hi)}
.shitem:hover{border-color:rgba(var(--hippo-amber-rgb),.4)}
.shitem.danger{border-color:rgba(var(--hippo-down-rgb),.5);color:var(--hippo-down)}
.shitem.danger:hover{border-color:var(--hippo-down)}
/* settings: answer-language row + clear-memory confirm */
.setlab{font-family:var(--hippo-font-mono);font-size:8.5px;letter-spacing:.14em;color:var(--hippo-text-faint);margin-top:2px}
.langrow{display:flex;gap:6px}
.lang{flex:1;border:1px solid var(--hippo-hairline);border-radius:10px;padding:8px 4px;font-size:11px;
  color:var(--hippo-text-mid);text-align:center}
.lang:hover{border-color:rgba(var(--hippo-amber-rgb),.4);color:var(--hippo-text-hi)}
.lang.on{border-color:rgba(var(--hippo-amber-rgb),.6);background:rgba(var(--hippo-amber-rgb),.08);color:var(--hippo-text-hi)}
.confirmrow{display:flex;gap:7px}
.confirmrow .shitem{flex:1;text-align:center}
.cleared{font-family:var(--hippo-font-mono);font-size:9px;letter-spacing:.12em;color:var(--hippo-up);text-align:center;padding:11px}
/* shared focus ring — every interactive element inside the panel */
.chip:focus-visible,.livebar button:focus-visible,.fbchip:focus-visible,.fbskip:focus-visible,
.composer textarea:focus-visible,.send:focus-visible,.jump:focus-visible,.shrx:focus-visible,
.shitem:focus-visible,.lang:focus-visible,.obnotnow:focus-visible,.omanage:focus-visible,
.cta:focus-visible,.await .cxl:focus-visible,.obcheck:focus-visible{
  outline:2px solid var(--hippo-amber);outline-offset:1px}
/* ── light lean — PURE token swap (redeclares tokens only) ── */
:host([data-theme="light"]){
  --hippo-panel-top:#F7F8FA;--hippo-panel-bottom:#E9ECF1;--hippo-panel:#F7F8FA;
  --hippo-card:#FFFFFF;--hippo-card-2:#F0F2F6;--hippo-user-bubble:#F0F2F6;
  --hippo-skeleton-1:#E4E7EE;--hippo-skeleton-2:#F2F4F8;
  --hippo-amber:#B98A1E;--hippo-amber-ink:#FFFFFF;--hippo-amber-tint:#7A5B12;
  --hippo-up:#149469;--hippo-down:#D94F4F;
  --hippo-text-hi:rgba(14,18,26,.92);--hippo-text-mid:rgba(14,18,26,.62);
  --hippo-text-dim:rgba(14,18,26,.46);--hippo-text-faint:rgba(14,18,26,.42);--hippo-text-dim-2:rgba(14,18,26,.52);
  --hippo-amber-rgb:185,138,30;--hippo-up-rgb:20,148,105;--hippo-down-rgb:217,79,79;
  --hippo-white-rgb:12,16,24;--hippo-black-rgb:60,70,90;--hippo-bg-rgb:233,236,241;
  --hippo-panel-deep-rgb:225,229,236;--hippo-surface-rgb:240,242,246;
  --hippo-hairline:rgba(12,16,24,.09)}
`
