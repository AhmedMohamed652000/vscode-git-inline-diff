'use strict';
// Generates HTML mock-ups of the Hunkly UI (dark VS Code look) + pages.json with the window size of each page.
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });

const W = 1180; // editor window width
const LH = 19; // VS Code line height at 14px
const PAD = 24; // transparent margin around the window (shadow)
const GUTTER = 84; // line numbers + glyph margin
const LABEL = 'origin/development';

const C = { k: '#569cd6', s: '#ce9178', f: '#dcdcaa', v: '#9cdcfe', c: '#6a9955', n: '#b5cea8', t: '#4ec9b0' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hl = (s) => esc(s).replace(/\{([kscfvnt]):([^}]*)\}/g, (m, c, t) => `<span style="color:${C[c]}">${t}</span>`);
const plain = (s) => esc(s).replace(/\{[kscfvnt]:([^}]*)\}/g, '$1');

const KIND = {
  mine: {
    line: 'rgba(155,185,85,.2)', rows: 'rgba(255,0,0,.2)', gutter: '#3fb950', chipBg: 'rgba(255,0,0,.2)', chipFg: '#e06c5c', prefix: '−',
    tag: `yours · not on ${LABEL}`, buttons: [['Reject', 'danger'], ['Accept', 'ok']],
  },
  incoming: {
    line: 'rgba(64,166,255,.2)', rows: 'rgba(64,166,255,.2)', gutter: '#58a6ff', chipBg: 'rgba(64,166,255,.45)', chipFg: '#e8e8e8', prefix: '+',
    tag: `incoming from ${LABEL} · not pulled yet`, buttons: [['Accept incoming', 'info'], ['Dismiss', 'plain']],
  },
  conflict: {
    line: 'rgba(158,106,3,.2)', rows: 'rgba(158,106,3,.2)', gutter: '#d29922', chipBg: 'rgba(158,106,3,.5)', chipFg: '#e2b93d', prefix: '⇄',
    tag: `conflict · you and ${LABEL} both changed this`, buttons: [['Accept current', 'ok'], ['Accept incoming', 'info'], ['Accept both', 'plain']],
  },
};

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{padding:${PAD}px;font-family:"Segoe WPC","Segoe UI",system-ui,sans-serif;color:#cccccc;-webkit-font-smoothing:antialiased}
.win{width:${W}px;background:#1e1e1e;border:1px solid #3c3c3c;border-radius:8px;overflow:hidden;box-shadow:0 12px 36px rgba(0,0,0,.5);position:relative}
.tabs{height:35px;background:#252526;display:flex;align-items:stretch}
.tab{padding:0 14px 0 12px;display:flex;align-items:center;gap:8px;font-size:13px;background:#1e1e1e;color:#ffffff;border-top:1px solid #0078d4}
.tab .ico{font-size:10px;font-weight:700;color:#cbcb41;letter-spacing:.5px}
.tab .dot{width:8px;height:8px;border-radius:50%;background:#e2c08d;margin-left:4px}
.crumbs{height:22px;font-size:12px;color:#a9a9a9;display:flex;align-items:center;padding:0 16px;gap:6px}
.crumbs .sep{opacity:.6}
.editor{position:relative;font-family:Consolas,"Cascadia Mono","Courier New",monospace;font-size:14px;line-height:${LH}px;padding:4px 0 10px;color:#d4d4d4}
.line{display:flex;height:${LH}px;white-space:pre;align-items:center}
.ln{width:60px;flex:none;text-align:right;color:#6e7681;padding-right:12px}
.ln.active{color:#cccccc}
.glyph{width:24px;flex:none;position:relative;height:${LH}px}
.glyph .bar{position:absolute;left:6px;top:0;width:3px;height:${LH}px;border-radius:1px}
.code{flex:1 1 auto;min-width:0}
.chip{display:inline-block;margin-left:2em;padding:0 6px;border-radius:3px}
.hint{margin-left:3em;font-style:italic;font-size:.85em;color:#999999}
.zone{margin-left:${GUTTER}px}
.zr{display:flex;height:${LH}px;align-items:center;white-space:pre;overflow:hidden}
.zr .p{display:inline-block;width:1.6em;text-align:center;opacity:.7;flex:none}
.zr .t{flex:1 1 auto;min-width:0}
.zr .hdr{font-size:.8em;font-style:italic;opacity:.9;letter-spacing:.02em}
.abar .zr{gap:6px;padding:0 8px 0 6px;filter:brightness(1.12)}
.abar .top{padding-top:2px}
.abar .bottom{align-items:flex-start;padding-top:3px}
.tag{flex:none;font-size:.74em;opacity:.85;padding:0 7px;border:1px solid currentColor;border-radius:9px;line-height:1.4;white-space:nowrap}
.b{flex:none;font:inherit;font-size:.78em;line-height:1.35;padding:0 8px;border:1px solid transparent;border-radius:4px;white-space:nowrap;color:#d4d4d4;background:#3a3d41}
.b.plain{border-color:rgba(128,128,128,.55);background:transparent}
.b.ok{background:rgba(46,160,67,.4)}
.b.danger{background:rgba(248,81,73,.4)}
.b.info{background:rgba(64,166,255,.4)}
.b.nav{padding:0 6px;border-color:rgba(128,128,128,.55);background:transparent}
.sep{flex:none;width:1px;height:1.1em;margin:0 4px;background:rgba(128,128,128,.5)}
.pos{flex:none;font-size:.74em;opacity:.75;white-space:nowrap}
.lens{height:${LH}px;display:flex;align-items:flex-end;font-family:"Segoe WPC","Segoe UI",sans-serif;font-size:12px;color:#999999;padding-bottom:1px}
.lens span{white-space:nowrap}
.lens .lsep{margin:0 6px;opacity:.6}
.status{height:22px;background:#007acc;color:#ffffff;font-size:12px;display:flex;align-items:center;justify-content:space-between;padding:0 6px}
.status .g{display:flex;align-items:center}
.status .it{padding:0 5px;height:22px;display:flex;align-items:center;gap:4px;white-space:nowrap}
.status .it.hl{background:rgba(255,255,255,.14);border-radius:2px}
/* hover widget */
.hover{position:absolute;background:#252526;border:1px solid #454545;box-shadow:0 2px 10px rgba(0,0,0,.6);padding:8px 10px;font-family:"Segoe WPC","Segoe UI",sans-serif;font-size:13px;line-height:1.5;color:#cccccc;border-radius:3px}
.hover code{font-family:Consolas,"Cascadia Mono",monospace;background:rgba(10,10,10,.4);padding:0 4px;border-radius:3px;font-size:12.5px}
.hover pre{font-family:Consolas,"Cascadia Mono",monospace;font-size:13px;line-height:18px;background:rgba(10,10,10,.4);padding:6px 8px;margin:6px 0;border-radius:3px;white-space:pre}
.hover .del{color:#ce9178}.hover .add{color:#b5cea8}
.hover a{color:#3794ff;text-decoration:none}
/* quick pick */
.qp{position:absolute;left:50%;transform:translateX(-50%);top:0;width:620px;background:#252526;border:1px solid #454545;box-shadow:0 4px 14px rgba(0,0,0,.6);padding:6px;font-family:"Segoe WPC","Segoe UI",sans-serif;font-size:13px;border-radius:0 0 6px 6px}
.qp .in{height:26px;background:#313131;border:1px solid #0078d4;color:#989898;padding:0 8px;display:flex;align-items:center;margin-bottom:6px}
.qp .it{height:22px;display:flex;align-items:center;padding:0 10px;gap:8px;color:#cccccc;border-radius:3px}
.qp .it.sel{background:#04395e}
.qp .it .d{color:#9d9d9d;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qp .it .i{width:16px;text-align:center;opacity:.9}
`;

function statusBar(s) {
  const left = s.left.map(([t, hl]) => `<span class="it${hl ? ' hl' : ''}">${t}</span>`).join('');
  const right = (s.right || ['Ln 43, Col 88', 'Spaces: 2', 'UTF-8', 'CRLF', '{ } JavaScript']).map((t) => `<span class="it">${t}</span>`).join('');
  return `<div class="status"><div class="g">${left}</div><div class="g">${right}</div></div>`;
}

function page(name, o) {
  let h = 0;
  const parts = [];
  for (const it of o.items) {
    if (it.code !== undefined) {
      const k = it.kind ? KIND[it.kind] : null;
      const ck = KIND[it.chipKind || it.kind || 'mine'];
      const chip = it.chip ? `<span class="chip" style="background:${ck.chipBg};color:${ck.chipFg}">${esc(it.chip)}</span>` : '';
      const hint = it.hint ? `<span class="hint">${esc(it.hint)}</span>` : '';
      parts.push(
        `<div class="line" style="${k ? `background:${k.line}` : ''}"><span class="ln${it.active ? ' active' : ''}">${it.ln == null ? '' : it.ln}</span>` +
          `<span class="glyph">${k ? `<span class="bar" style="background:${k.gutter}"></span>` : ''}</span><span class="code">${hl(it.code)}${chip}${hint}</span></div>`
      );
      h += LH;
    } else if (it.rows) {
      const k = KIND[it.kind || 'mine'];
      const conflict = it.kind === 'conflict';
      const rows = [];
      if (conflict) rows.push(`<div class="zr" style="background:${KIND.incoming.rows}"><span class="p">↓</span><span class="t hdr">incoming from ${LABEL}</span></div>`);
      for (const l of it.rows) rows.push(`<div class="zr" style="background:${conflict ? KIND.incoming.rows : k.rows}"><span class="p">${conflict ? '+' : k.prefix}</span><span class="t">${plain(l)}</span></div>`);
      if (conflict) rows.push(`<div class="zr" style="background:${k.rows}"><span class="p">↓</span><span class="t hdr">current · yours</span></div>`);
      parts.push(`<div class="zone">${rows.join('')}</div>`);
      h += LH * rows.length;
    } else if (it.bar) {
      const k = KIND[it.bar];
      const btns =
        k.buttons.map(([t, cls]) => `<button class="b ${cls}">${t}</button>`).join('') +
        `<button class="b plain">⧉ diff</button><span class="sep"></span><span class="pos">${it.index} / ${it.total}</span><button class="b nav">↑</button><button class="b nav">↓</button>`;
      parts.push(`<div class="zone abar"><div class="zr top" style="background:${k.rows}"><span class="tag">${k.tag}</span></div><div class="zr bottom" style="background:${k.rows}">${btns}</div></div>`);
      h += LH * 2;
    } else if (it.lens) {
      parts.push(`<div class="zone lens">${it.lens.map((t) => `<span>${esc(t)}</span>`).join('<span class="lsep">|</span>')}</div>`);
      h += LH;
    }
  }
  const H = 35 + 22 + 4 + h + 10 + 22 + 2 + (o.extra || 0);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="win">
  <div class="tabs"><div class="tab"><span class="ico">JS</span>${o.file}<span class="dot"></span></div></div>
  <div class="crumbs">${o.crumbs.map((c) => esc(c)).join('<span class="sep">›</span>')}</div>
  <div class="editor" style="min-height:${4 + h + 10 + (o.extra || 0)}px">${parts.join('')}${o.overlay || ''}</div>
  ${statusBar(o.status)}
</div></body></html>`;
  fs.writeFileSync(path.join(outDir, name + '.html'), html);
  return { name, w: W + 2 * PAD, h: H + 2 * PAD };
}

const STATUS_FULL = { left: [['⎇ development*'], [`⚠ ${LABEL}: 3 mine · 2 incoming · 1 conflict`, true], ['↑'], ['↓']] };
const HINT = 'Reject Ctrl+N · Accept Ctrl+Shift+Y';

const costHead = [
  { ln: 36, code: '{k:async} {k:function} {f:approximateCost}({v:ride}, {v:zone}) {' },
  { ln: 37, code: '  {k:const} {v:distance} = {k:await} {f:getDistance}({v:ride}.{v:pickup}, {v:ride}.{v:dropoff});' },
  { ln: 38, code: '  {k:const} {v:duration} = {k:await} {f:getDuration}({v:ride}.{v:pickup}, {v:ride}.{v:dropoff});' },
  { ln: 39, code: '  {k:const} {v:carType} = {v:zone}.{v:car_types}.{f:find}(({v:c}) => {v:c}.{v:id} === {v:ride}.{v:car_type_id});' },
  { ln: 40, code: '' },
  { ln: 41, code: '  {c:// base fare + per-meter + per-minute, then the zone\'s additional fees}' },
];
const costTail = [
  { ln: 44, code: '' },
  { ln: 45, code: '  {k:return} {f:applyAdditionalFees}({v:cost}, {v:zone}.{v:additional_fees});' },
  { ln: 46, code: '}' },
  { ln: 47, code: '' },
  { ln: 48, code: '{v:module}.{v:exports} = { {v:approximateCost} };' },
];

const pages = [];

// 1. hero: one "mine" hunk with red rows above, green lines, action bar below
pages.push(
  page('hero', {
    file: 'cost.controller.js',
    crumbs: ['src', 'controller', 'cost.controller.js', 'approximateCost'],
    status: STATUS_FULL,
    items: [
      ...costHead,
      { rows: ['  const base = carType.base_fare;', '  const cost = base + distance * carType.per_meter;'], kind: 'mine' },
      { ln: 42, kind: 'mine', code: '  {k:const} {v:base} = {f:pickBaseFare}({v:carType}, {v:ride}.{v:scheduled_at});' },
      { ln: 43, kind: 'mine', active: true, code: '  {k:const} {v:cost} = {v:base} + {v:distance} * {v:carType}.{v:per_meter} + {v:duration} * {v:carType}.{v:per_minute};', hint: HINT },
      { bar: 'mine', index: 1, total: 6 },
      ...costTail,
    ],
  })
);

// 2. kinds: mine / incoming / conflict in one file
pages.push(
  page('kinds', {
    file: 'pricing.js',
    crumbs: ['src', 'functions', 'pricing.js', 'priceFor'],
    status: { left: [['⎇ development*'], [`⚠ ${LABEL}: 1 mine · 1 incoming · 1 conflict`, true], ['↑'], ['↓']], right: ['Ln 20, Col 5', 'Spaces: 2', 'UTF-8', 'CRLF', '{ } JavaScript'] },
    items: [
      { ln: 12, code: '{k:function} {f:priceFor}({v:zone}, {v:carType}, {v:ride}) {' },
      { ln: 13, code: '  {k:const} {v:slot} = {f:findTimeSlot}({v:zone}, {v:ride}.{v:scheduled_at});' },
      { rows: ['  const rate = slot ? slot.rate : carType.per_meter;'], kind: 'mine' },
      { ln: 14, kind: 'mine', code: '  {k:const} {v:rate} = {v:slot}?.{v:rate} ?? {v:carType}.{v:per_meter};' },
      { bar: 'mine', index: 1, total: 3 },
      { ln: 15, code: '  {k:const} {v:distance} = {v:ride}.{v:distance_m};' },
      { ln: 16, code: '' },
      { rows: ['  const minimum = Math.max(zone.min_fare, carType.min_fare);'], kind: 'incoming' },
      { ln: 17, kind: 'incoming', code: '  {k:const} {v:minimum} = {v:zone}.{v:min_fare};' },
      { bar: 'incoming', index: 2, total: 3 },
      { ln: 18, code: '  {k:let} {v:total} = {v:Math}.{f:max}({v:minimum}, {v:rate} * {v:distance});' },
      { ln: 19, code: '' },
      { rows: ['  total = applyWaitingTime(total, ride.waiting_s, carType);'], kind: 'conflict' },
      { ln: 20, kind: 'conflict', active: true, code: '  {v:total} = {f:applyWaiting}({v:total}, {v:ride}.{v:waiting_s}, {v:carType}.{v:per_minute});' },
      { bar: 'conflict', index: 3, total: 3 },
      { ln: 21, code: '  {k:return} {f:round2}({v:total});' },
      { ln: 22, code: '}' },
    ],
  })
);

// 3. fallback: chips at the end of the line + CodeLens (no proposed API needed)
pages.push(
  page('fallback', {
    file: 'cost.controller.js',
    crumbs: ['src', 'controller', 'cost.controller.js', 'approximateCost'],
    status: { left: [['⎇ development*'], [`⇄ ${LABEL}: 2 mine`, true], ['↑'], ['↓']], right: ['Ln 42, Col 45', 'Spaces: 2', 'UTF-8', 'CRLF', '{ } JavaScript'] },
    items: [
      ...costHead.slice(0, 4),
      { ln: 40, code: '' },
      { lens: ['✓ Accept', '✕ Reject', `⇄ -2 +2 vs ${LABEL}`] },
      { ln: 41, kind: 'mine', code: '  {k:const} {v:base} = {f:pickBaseFare}({v:carType}, {v:ride});', chip: '− const base = carType.base_fare;' },
      { ln: 42, kind: 'mine', active: true, code: '  {k:const} {v:cost} = {v:base} + {v:distance} * {v:rate};', chip: '− const cost = base + distance * carType.per_meter;', hint: HINT },
      { ln: 43, code: '' },
      { ln: 44, code: '  {k:return} {f:applyAdditionalFees}({v:cost}, {v:zone}.{v:additional_fees});' },
      { ln: 45, code: '}' },
    ],
  })
);

// 4. hover: the full -/+ diff of the hunk under the mouse
const hoverHtml = `<div class="hover" style="top:${4 + LH * 12 + 6}px;left:${GUTTER + 60}px;width:640px">
<b>Hunkly</b> · vs <code>${LABEL}</code>
<pre><span class="del">- const base = carType.base_fare;</span>
<span class="del">- const cost = base + distance * carType.per_meter;</span>
<span class="add">+ const base = pickBaseFare(carType, ride.scheduled_at);</span>
<span class="add">+ const cost = base + distance * carType.per_meter + duration * carType.per_minute;</span></pre>
<a href="#">✓ Accept</a> · <a href="#">✕ Reject</a> · <a href="#">⇄ Open diff</a>
</div>`;
pages.push(
  page('hover', {
    file: 'cost.controller.js',
    crumbs: ['src', 'controller', 'cost.controller.js', 'approximateCost'],
    status: STATUS_FULL,
    overlay: hoverHtml,
    extra: 60,
    items: [
      ...costHead,
      { rows: ['  const base = carType.base_fare;', '  const cost = base + distance * carType.per_meter;'], kind: 'mine' },
      { ln: 42, kind: 'mine', code: '  {k:const} {v:base} = {f:pickBaseFare}({v:carType}, {v:ride}.{v:scheduled_at});' },
      { ln: 43, kind: 'mine', active: true, code: '  {k:const} {v:cost} = {v:base} + {v:distance} * {v:carType}.{v:per_meter} + {v:duration} * {v:carType}.{v:per_minute};' },
      { bar: 'mine', index: 1, total: 6 },
      ...costTail,
      { ln: 49, code: '' },
      { ln: 50, code: '' },
      { ln: 51, code: '' },
    ],
  })
);

// 5. menu: the status bar quick pick
const menuItems = [
  ['⇄', `Open diff against ${LABEL}`, 'Cursor-like inline view (set diffEditor.renderSideBySide = false)', true],
  ['▤', 'Review all changed files', `every file that differs from ${LABEL}`],
  ['◉', 'Open base version', `${LABEL} read-only, side by side`],
  ['✓', 'Accept all (6)', 'keep my version, hide the highlights'],
  ['↶', 'Reject all (6)', `restore the ${LABEL} version of this file`],
  ['☁', 'Fetch remote and refresh', 'git fetch, then compare again'],
  ['↻', 'Refresh', ''],
  ['⚙', 'Compare against…', 'current: upstream'],
  ['⊘', 'Disable Hunkly', ''],
];
const menuHtml = `<div class="qp"><div class="in">Hunkly · ${LABEL}: 3 mine · 2 incoming · 1 conflict — pick an action</div>${menuItems
  .map(([i, l, d, sel]) => `<div class="it${sel ? ' sel' : ''}"><span class="i">${i}</span><span>${esc(l)}</span>${d ? `<span class="d">${esc(d)}</span>` : ''}</div>`)
  .join('')}</div>`;
pages.push(
  page('menu', {
    file: 'cost.controller.js',
    crumbs: ['src', 'controller', 'cost.controller.js', 'approximateCost'],
    status: STATUS_FULL,
    overlay: menuHtml,
    items: [
      ...costHead,
      { rows: ['  const base = carType.base_fare;', '  const cost = base + distance * carType.per_meter;'], kind: 'mine' },
      { ln: 42, kind: 'mine', code: '  {k:const} {v:base} = {f:pickBaseFare}({v:carType}, {v:ride}.{v:scheduled_at});' },
      { ln: 43, kind: 'mine', code: '  {k:const} {v:cost} = {v:base} + {v:distance} * {v:carType}.{v:per_meter} + {v:duration} * {v:carType}.{v:per_minute};' },
      { bar: 'mine', index: 1, total: 6 },
      ...costTail,
      { ln: 49, code: '' },
      { ln: 50, code: '' },
    ],
  })
);

fs.writeFileSync(path.join(outDir, 'pages.json'), JSON.stringify(pages, null, 2));
console.log(pages.map((p) => `${p.name} ${p.w}x${p.h}`).join('\n'));
