/**
 * Panel styles — Dark Glass Instrument tokens ported 1:1 from the prototype.
 * Injected as a constructable stylesheet into the closed shadow root.
 * Hard rule: solid card backgrounds inside the scroll container;
 * backdrop-filter is reserved for full-surface overlays only (iOS/WebKit).
 */
export const panelCss = /* css */ `
:host{all:initial}
*{margin:0;padding:0;box-sizing:border-box}
.panel{position:fixed;right:0;top:0;bottom:0;width:360px;z-index:2147483001;
  background:linear-gradient(175deg,#15171D,#101217);border-left:1px solid rgba(255,255,255,.07);
  display:flex;flex-direction:column;color:#E9EBF0;
  font-family:'Inter',system-ui,sans-serif;font-size:14px;
  --amber:#F0B94A;--up:#2EC48D;--down:#FF8585;--dim:#8A8F9C;--faint:#6A7080;
  --hairline:rgba(255,255,255,.07);
  --mono:'IBM Plex Mono',ui-monospace,monospace;--disp:'Outfit',system-ui,sans-serif}
.panel.max{width:620px;box-shadow:-30px 0 60px rgba(0,0,0,.45);border-left-color:rgba(240,185,74,.25)}
.panel.hidden{display:none}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
/* header */
.hd{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--hairline);flex-shrink:0}
.hd .mark{width:24px;height:24px;border-radius:8px;background:var(--amber);color:#15171D;
  display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:12px}
.hd .name{font-family:var(--disp);font-weight:600;font-size:13.5px}
.hd .name small{display:block;font-family:var(--mono);font-weight:400;font-size:8.5px;letter-spacing:.12em;color:var(--faint);margin-top:1px}
.hd .ctl{margin-left:auto;display:flex;gap:6px}
.hd .ctl button{width:26px;height:26px;border-radius:8px;border:1px solid var(--hairline);
  background:rgba(255,255,255,.03);color:var(--dim);font-size:12px;display:grid;place-items:center}
.hd .ctl button:hover{color:#E9EBF0;border-color:rgba(255,255,255,.18)}
.hd .ctl button:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
/* orders strip */
.orders{flex-shrink:0;padding:9px 13px 10px;border-bottom:1px solid var(--hairline);background:rgba(20,22,28,.4)}
.orders .lab{font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;color:var(--faint);
  margin-bottom:7px;display:flex;justify-content:space-between}
.orders .lab .cnt{color:var(--amber)}
.orders .row{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none}
.orders .row::-webkit-scrollbar{display:none}
.opill{flex-shrink:0;display:flex;align-items:center;gap:7px;background:rgba(38,42,52,.6);
  border:1px solid var(--hairline);border-radius:999px;padding:7px 12px;
  font-family:var(--mono);font-size:10.5px;color:#E9EBF0;white-space:nowrap}
.opill .sd{width:6px;height:6px;border-radius:50%}
.opill.buy .sd{background:var(--up)}.opill.sell .sd{background:var(--down)}
.opill .st{color:var(--faint);font-size:9px}
.opill.new{border:1px dashed rgba(240,185,74,.5);color:var(--amber);font-family:var(--disp);font-weight:600;font-size:11px}
.opill.on{border-color:rgba(240,185,74,.6);background:rgba(240,185,74,.08)}
.opill:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
/* order pill expand — in place below the strip, max-height animated (§3) */
.oexp{overflow:hidden;max-height:0;transition:max-height .28s ease}
.oexp.open{max-height:240px}
@media (prefers-reduced-motion:reduce){.oexp{transition:none}}
.ocard{margin-top:9px;background:#232733;border:1px solid rgba(255,255,255,.08);border-radius:13px;
  padding:11px 12px;display:flex;flex-direction:column;gap:8px}
.ocard .och{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.oside{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;padding:3px 8px;border-radius:999px}
.oside.buy{background:rgba(46,196,141,.12);color:var(--up)}
.oside.sell{background:rgba(255,133,133,.12);color:var(--down)}
.ocard .osum{font-family:var(--mono);font-weight:500;font-size:11.5px}
.ocard .odet{font-family:var(--mono);font-size:9px;color:var(--dim);border:1px solid var(--hairline);border-radius:999px;padding:2px 7px}
.ocard .ostat{font-family:var(--mono);font-size:9px;letter-spacing:.12em;color:var(--amber)}
.omanage{font-family:var(--disp);font-weight:600;font-size:11.5px;text-align:center;padding:9px 12px;
  border:1px solid var(--hairline);border-radius:10px;background:rgba(20,22,28,.7);color:#E9EBF0}
.omanage:hover{border-color:rgba(240,185,74,.4)}
/* + New order hint — conversational, never a form */
.newhint{margin-top:9px;border:1px dashed rgba(240,185,74,.5);border-radius:13px;padding:11px 12px}
.newhint b{display:block;font-family:var(--disp);font-weight:600;font-size:12px;color:var(--amber);margin-bottom:8px}
.nchips{display:flex;gap:7px;flex-wrap:wrap}
/* thread */
.thread{overflow-y:auto;padding:13px;display:flex;flex-direction:column;gap:11px;flex:1;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.thread>*{flex-shrink:0;animation:msgIn .3s ease both}
@media (prefers-reduced-motion:reduce){.thread>*{animation:none}}
@keyframes msgIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.umsg{align-self:flex-end;max-width:80%;font-size:12.5px;line-height:1.45;padding:9px 13px;
  border-radius:14px 14px 5px 14px;background:#2A2E38;border:1px solid var(--hairline)}
.bubble{align-self:flex-start;max-width:96%;border-radius:15px;padding:13px;background:#232733;border:1px solid rgba(255,255,255,.08)}
.eyebrow{font-family:var(--mono);font-size:9px;letter-spacing:.14em;margin-bottom:7px;display:flex;justify-content:space-between;color:var(--dim)}
.eyebrow .live{color:var(--amber)}
.bubble h3{font-family:var(--disp);font-size:15px;font-weight:600;margin-bottom:5px}
.bubble p{font-size:12.5px;line-height:1.58;color:#B8BDC9}
.bubble p+p{margin-top:6px}
.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:10px 0 3px}
.kv div{border-radius:9px;padding:7px 8px;background:rgba(20,22,28,.7);border:1px solid var(--hairline)}
.kv .k{font-family:var(--mono);font-size:8px;letter-spacing:.12em;display:block;margin-bottom:3px;color:var(--faint)}
.kv .v{font-family:var(--mono);font-size:11.5px;font-weight:500}
.kv .v.neg{color:var(--down)}.kv .v.pos{color:var(--up)}
svg.spark{display:block;width:100%;height:48px;margin-top:7px}
.spark .line{stroke:var(--amber);fill:none;stroke-width:1.5;stroke-linecap:round}
.spark .fill{fill:rgba(240,185,74,.07)}
.figcap{font-family:var(--mono);font-size:9px;display:flex;justify-content:space-between;margin-top:4px;color:var(--faint)}
.srcs{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
.src{font-family:var(--mono);font-size:9px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.06);color:#9BA1AE}
/* live bar */
.livebar{display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:9px;
  border-top:1px dashed rgba(255,255,255,.08);font-family:var(--mono);font-size:8.5px;letter-spacing:.1em}
.livebar .asof{color:var(--faint);margin-right:auto;transition:color .3s}
.livebar .asof.flash{color:var(--amber)}
.livebar button{color:#9BA1AE;font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;padding:2px 0}
.livebar button:hover{color:var(--amber)}
/* stale data — declared, never silent: as-of turns amber, REFRESH gets loud */
.livebar.stale .asof{color:var(--amber)}
.livebar.stale .rf{background:var(--amber);color:#15171D;font-weight:600;padding:4px 9px;border-radius:999px}
.livebar.stale .rf:hover{color:#15171D}
.fb{display:flex;gap:7px;align-items:center}
.fb button{font-size:12px;filter:grayscale(1);opacity:.5}
.fb button:hover{opacity:.95}
.fb .done{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--amber)}
/* 👎 follow-up — one line in the live-bar area; reasons map 1:1 to eval criteria */
.fbask{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;
  font-family:var(--mono);font-size:8.5px;letter-spacing:.08em}
.fbask .q{color:var(--faint)}
.fbchip{border:1px solid var(--hairline);border-radius:999px;padding:3px 9px;background:rgba(255,255,255,.04);
  font-family:var(--mono);font-size:8.5px;letter-spacing:.05em;color:#B8BDC9}
.fbchip:hover{border-color:rgba(240,185,74,.4);color:#E9EBF0}
.fbskip{margin-left:auto;font-family:var(--mono);font-size:8.5px;color:var(--faint);padding:2px 0}
.fbskip:hover{color:#E9EBF0}
.cache-badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:8px;
  letter-spacing:.12em;color:var(--amber);background:rgba(240,185,74,.1);border-radius:999px;padding:3px 8px;margin-bottom:8px}
/* ticket */
.ticket{align-self:flex-start;width:94%;border-radius:16px;overflow:hidden;background:#262B36;border:1px solid rgba(240,185,74,.35)}
.ticket .th{display:flex;justify-content:space-between;align-items:center;padding:11px 13px;border-bottom:1px solid var(--hairline)}
.ticket .tt{font-family:var(--disp);font-weight:600;font-size:13px}
.ticket .side{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;padding:3px 9px;border-radius:999px}
.ticket .side.buy{background:rgba(46,196,141,.12);color:var(--up)}
.ticket .side.sell{background:rgba(255,133,133,.12);color:var(--down)}
.ticket .tb{padding:2px 13px 3px}
.trow{display:flex;justify-content:space-between;padding:7px 0;font-size:12.5px}
.trow+.trow{border-top:1px dashed rgba(255,255,255,.09)}
.trow .lab{font-size:10.5px;align-self:center;color:var(--dim)}
.trow b{font-family:var(--mono);font-weight:500;font-size:11.5px}
.cta{display:block;width:calc(100% - 26px);margin:9px 13px 11px;font-family:var(--disp);font-weight:600;
  font-size:12.5px;padding:12px;border-radius:11px;background:var(--amber);color:#15171D;text-align:center}
.tfoot{font-size:9.5px;text-align:center;padding:0 13px 11px;line-height:1.5;color:var(--faint)}
/* lifecycle */
.await{display:flex;align-items:center;gap:8px;padding:10px 13px;border-top:1px dashed rgba(255,255,255,.09);
  font-family:var(--mono);font-size:9px;letter-spacing:.1em;color:var(--amber)}
.await .pulse{width:7px;height:7px;border-radius:50%;background:var(--amber);animation:hpulse 1.2s ease infinite}
@keyframes hpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}
.await .cxl{margin-left:auto;color:var(--faint);font-family:var(--mono);font-size:9px;letter-spacing:.1em}
.await .cxl:hover{color:var(--down)}
.ticket.ok{border-color:rgba(46,196,141,.45)}
.oid{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--faint);text-align:center;padding-bottom:11px}
/* decline */
.decline{align-self:flex-start;max-width:94%;border-radius:15px;overflow:hidden;background:#232733;
  border:1px solid rgba(255,255,255,.08);border-left:3px solid var(--amber)}
.decline .dchead{padding:10px 13px 0}
.dcbadge{display:inline-flex;gap:5px;font-family:var(--mono);font-size:8px;letter-spacing:.14em;color:var(--amber);
  background:rgba(240,185,74,.1);border-radius:999px;padding:3px 9px}
.decline .body{padding:9px 13px 12px}
.decline .body>p{font-size:12.5px;line-height:1.58;color:#B8BDC9}
.decline .pivot{font-family:var(--disp);font-weight:600;font-size:12.5px;color:#E9EBF0;margin:10px 0 8px}
.facts{display:flex;flex-direction:column;gap:6px}
.fact{display:flex;gap:9px;font-size:12px;line-height:1.5;color:#B8BDC9;background:rgba(20,22,28,.6);
  border:1px solid var(--hairline);border-radius:10px;padding:8px 11px}
.fact .fi{color:var(--amber);flex-shrink:0;font-size:11px}
/* thinking / skeleton */
.think{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;color:var(--dim)}
.think .dot{width:7px;height:7px;border-radius:50%;background:var(--amber);animation:hpulse 1.1s ease infinite}
.sk{background:linear-gradient(90deg,#2A2F3B 25%,#353B49 37%,#2A2F3B 63%);background-size:400% 100%;
  animation:shim 1.2s linear infinite;border-radius:6px}
@keyframes shim{0%{background-position:100% 0}100%{background-position:0 0}}
.sk-title{height:13px;width:70%;margin-bottom:9px}.sk-line{height:9px;width:100%;margin-bottom:6px}
.sk-line.short{width:55%}
.sk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:10px}
.sk-cell{height:38px;border-radius:9px}
/* streaming brief prose (brief_delta) */
.stream-text{white-space:pre-wrap}
.stream-cursor{display:inline-block;width:7px;height:12px;margin-left:2px;vertical-align:-1px;
  background:var(--amber);animation:hpulse 1.1s ease infinite}
/* positions */
.pos-row{display:flex;justify-content:space-between;gap:8px;padding:8px 0;font-family:var(--mono);font-size:11px}
.pos-row+.pos-row{border-top:1px dashed rgba(255,255,255,.09)}
.pos-row .neg{color:var(--down)}.pos-row .pos{color:var(--up)}
/* banner */
.banner{display:flex;gap:9px;padding:10px 13px;font-size:11px;line-height:1.5;border-radius:12px}
.banner.degraded{background:rgba(240,185,74,.1);border:1px solid rgba(240,185,74,.3);color:#E8CE93}
.banner.offline,.banner.info{background:rgba(255,255,255,.05);border:1px solid var(--hairline);color:#9BA1AE}
.banner b{font-family:var(--mono);font-size:9px;letter-spacing:.12em;display:block;margin-bottom:2px}
/* pinned banners — above the orders strip, never scroll away */
.pins{flex-shrink:0;display:flex;flex-direction:column;gap:7px;padding:9px 13px 0}
/* empty thread — never blank */
.empty{margin:auto;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:20px 8px}
.empty .emark{width:40px;height:40px;border-radius:13px;background:var(--amber);color:#15171D;
  display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:18px}
.empty h2{font-family:var(--disp);font-size:16.5px;font-weight:600}
.echips{display:flex;flex-direction:column;gap:7px}
/* chips + composer */
.chips{flex-shrink:0;padding:9px 13px 2px;display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;border-top:1px solid var(--hairline)}
.chips::-webkit-scrollbar{display:none}
.chip{flex-shrink:0;background:rgba(255,255,255,.04);border:1px solid var(--hairline);border-radius:999px;
  padding:7px 13px;font-size:11px;color:#B8BDC9;white-space:nowrap}
.chip:hover{border-color:rgba(240,185,74,.4);color:#E9EBF0}
.cwrap{flex-shrink:0}
.sendfail{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--amber);padding:8px 15px 0}
.composer{display:flex;align-items:center;gap:8px;padding:8px 13px 13px;flex-shrink:0}
.composer input{flex:1;font:inherit;font-size:12px;padding:10px 13px;border-radius:999px;
  background:rgba(38,42,52,.7);border:1px solid var(--hairline);color:#E9EBF0;outline:none}
.composer input:focus{border-color:rgba(240,185,74,.5)}
.composer input::placeholder{color:var(--faint)}
/* offline — composer locks with a reason; typed text is kept, never cleared */
.composer input:disabled{opacity:.55}
.composer input:disabled::placeholder{font-style:italic}
.composer .send:disabled{opacity:.4;cursor:default}
.composer .send{width:33px;height:33px;border-radius:11px;display:grid;place-items:center;
  font-size:14px;flex-shrink:0;background:var(--amber);color:#15171D}
/* fallback */
.fallback{align-self:flex-start;max-width:94%;border-radius:15px;padding:12px 13px;
  background:#232733;border:1px dashed rgba(255,255,255,.18)}
.fallback p{font-size:12.5px;line-height:1.55;color:#B8BDC9}
.fallback a{color:var(--amber)}
/* full-surface overlays — the ONLY place backdrop-filter is allowed */
.overlay{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(14,16,20,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  animation:ovIn .25s ease both}
@keyframes ovIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.overlay{animation:none}}
.confetti{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
/* onboarding */
.obcard{position:relative;width:100%;max-width:320px;background:#14161C;border:1px solid var(--hairline);
  border-radius:18px;padding:26px 22px 16px;text-align:center;display:flex;flex-direction:column;gap:12px;
  box-shadow:0 24px 60px rgba(0,0,0,.5)}
.obeyebrow{font-family:var(--mono);font-size:9px;letter-spacing:.22em;color:var(--amber)}
.obcard h2{font-family:var(--disp);font-size:21px;font-weight:600;line-height:1.25}
.obcard>p{font-size:12.5px;line-height:1.6;color:#B8BDC9}
.obmark{width:44px;height:44px;margin:0 auto;border-radius:14px;background:var(--amber);color:#15171D;
  display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:20px;
  box-shadow:0 0 34px rgba(240,185,74,.35)}
.tybar{display:flex;align-items:center;gap:2px;justify-content:center;min-height:38px;padding:10px 14px;
  border-radius:999px;background:rgba(38,42,52,.9);border:1px solid rgba(240,185,74,.45);
  box-shadow:0 0 22px rgba(240,185,74,.18);font-family:var(--mono);font-size:11px;color:#E9EBF0;
  white-space:nowrap;overflow:hidden}
.tybar .caret{flex-shrink:0;width:7px;height:14px;background:var(--amber);animation:tyblink 1s steps(1) infinite}
@keyframes tyblink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.tybar .caret{animation:none}}
.obrows{display:flex;flex-direction:column;gap:8px;text-align:left}
.obrow{display:flex;gap:10px;align-items:flex-start;background:rgba(20,22,28,.7);
  border:1px solid var(--hairline);border-radius:12px;padding:11px 12px}
.obrow .obicon{flex-shrink:0;font-size:13px;color:var(--amber)}
.obrow>div{flex:1}
.obrow b{display:block;font-family:var(--disp);font-weight:600;font-size:12px;margin-bottom:2px}
.obrow p{font-size:10.5px;line-height:1.5;color:var(--dim)}
.obcheck{flex-shrink:0;accent-color:var(--amber);width:15px;height:15px;margin-top:2px}
.tgl{flex-shrink:0;width:34px;height:20px;border-radius:999px;background:rgba(255,255,255,.14);
  position:relative;transition:background .2s;padding:0}
.tgl .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#E9EBF0;transition:transform .2s}
.tgl.on{background:var(--amber)}
.tgl.on .knob{transform:translateX(14px);background:#15171D}
.tgl:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.tgl,.tgl .knob{transition:none}}
.obcta{font-family:var(--disp);font-weight:600;font-size:12.5px;padding:12px;border-radius:11px;
  background:var(--amber);color:#15171D;margin-top:2px}
.obcta:focus-visible{outline:2px solid #E9EBF0;outline-offset:2px}
.obdots{display:flex;gap:6px;justify-content:center;padding-top:2px}
.obdots span{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.18)}
.obdots span.on{background:var(--amber)}
.obnotnow{font-family:var(--mono);font-size:9px;letter-spacing:.12em;color:var(--faint);padding:4px}
.obnotnow:hover{color:#E9EBF0}
/* share overlay — the live, co-branded card (baseline §6) */
.shrcard{position:relative;width:100%;max-width:320px;background:#14161C;border:1px solid rgba(240,185,74,.35);
  border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.shrbrand{display:flex;align-items:center;gap:7px;padding-right:28px}
.shrmark{width:20px;height:20px;border-radius:7px;background:var(--amber);color:#15171D;
  display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:10px}
.shrbrand b{font-family:var(--disp);font-size:12.5px;font-weight:600}
.shrbrand .on{color:var(--dim);font-size:11px}
.shrlive{margin-left:auto;font-family:var(--mono);font-size:8.5px;letter-spacing:.12em;color:var(--up)}
.shrcard h3{font-family:var(--disp);font-size:15px;font-weight:600;line-height:1.3}
.shrcard p{font-size:12px;line-height:1.55;color:#B8BDC9}
.shrfoot{display:flex;justify-content:space-between;gap:8px;font-family:var(--mono);font-size:8.5px;
  letter-spacing:.1em;color:var(--faint)}
.shrfoot .lnk{color:var(--amber)}
/* The printed advice-line disclaimer — part of the card, not chrome */
.shrdisc{font-family:var(--mono);font-size:8px;letter-spacing:.16em;color:var(--dim);text-align:center;
  border-top:1px dashed rgba(255,255,255,.08);padding-top:9px}
.shrx{position:absolute;top:10px;right:10px;width:24px;height:24px;border-radius:8px;
  border:1px solid var(--hairline);color:var(--dim);display:grid;place-items:center;font-size:10px}
.shrx:hover{color:#E9EBF0}
/* settings sheet */
.obcard.sheet{text-align:left;padding-top:18px}
.shhd{display:flex;justify-content:space-between;align-items:center}
.shhd b{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;color:var(--dim)}
.shhd button{width:24px;height:24px;border-radius:8px;border:1px solid var(--hairline);color:var(--dim);
  display:grid;place-items:center;font-size:10px}
.shhd button:hover{color:#E9EBF0}
.shitem{font-family:var(--disp);font-weight:600;font-size:12px;text-align:left;padding:11px 12px;
  border:1px solid var(--hairline);border-radius:12px;background:rgba(20,22,28,.7);color:#E9EBF0}
.shitem:hover{border-color:rgba(240,185,74,.4)}
`
