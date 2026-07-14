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
.fb{display:flex;gap:7px;align-items:center}
.fb button{font-size:12px;filter:grayscale(1);opacity:.5}
.fb button:hover{opacity:.95}
.fb .done{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--amber)}
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
/* positions */
.pos-row{display:flex;justify-content:space-between;gap:8px;padding:8px 0;font-family:var(--mono);font-size:11px}
.pos-row+.pos-row{border-top:1px dashed rgba(255,255,255,.09)}
.pos-row .neg{color:var(--down)}.pos-row .pos{color:var(--up)}
/* banner */
.banner{display:flex;gap:9px;padding:10px 13px;font-size:11px;line-height:1.5;border-radius:12px}
.banner.degraded{background:rgba(240,185,74,.1);border:1px solid rgba(240,185,74,.3);color:#E8CE93}
.banner.offline,.banner.info{background:rgba(255,255,255,.05);border:1px solid var(--hairline);color:#9BA1AE}
.banner b{font-family:var(--mono);font-size:9px;letter-spacing:.12em;display:block;margin-bottom:2px}
/* chips + composer */
.chips{flex-shrink:0;padding:9px 13px 2px;display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;border-top:1px solid var(--hairline)}
.chips::-webkit-scrollbar{display:none}
.chip{flex-shrink:0;background:rgba(255,255,255,.04);border:1px solid var(--hairline);border-radius:999px;
  padding:7px 13px;font-size:11px;color:#B8BDC9;white-space:nowrap}
.chip:hover{border-color:rgba(240,185,74,.4);color:#E9EBF0}
.composer{display:flex;align-items:center;gap:8px;padding:8px 13px 13px;flex-shrink:0}
.composer input{flex:1;font:inherit;font-size:12px;padding:10px 13px;border-radius:999px;
  background:rgba(38,42,52,.7);border:1px solid var(--hairline);color:#E9EBF0;outline:none}
.composer input:focus{border-color:rgba(240,185,74,.5)}
.composer input::placeholder{color:var(--faint)}
.composer .send{width:33px;height:33px;border-radius:11px;display:grid;place-items:center;
  font-size:14px;flex-shrink:0;background:var(--amber);color:#15171D}
/* fallback */
.fallback{align-self:flex-start;max-width:94%;border-radius:15px;padding:12px 13px;
  background:#232733;border:1px dashed rgba(255,255,255,.18)}
.fallback p{font-size:12.5px;line-height:1.55;color:#B8BDC9}
.fallback a{color:var(--amber)}
`
