'use strict';
// Cursor-style blocks drawn with the `editorInsets` proposed API (view zones holding a small webview):
//   • a "rows" block right ABOVE the hunk with the other side's lines (red / blue / orange),
//   • a 2-row "action bar" right BELOW the hunk (after your green lines): the kind chip, then the buttons.
// The bar content is packed to the left: a view zone is as wide as the longest line of the file, so anything
// right-aligned would end up outside the visible area of a narrow editor.
// When the proposal is not enabled for this extension the renderer marks itself unavailable and the
// controller falls back to the inline chips + CodeLens.

const vscode = require('vscode');
const crypto = require('crypto');
const { markerLine } = require('./diff');

const MAX_ROWS = 40; // rows per hunk before "… n more lines"
const MAX_INSETS = 80; // hunks per editor that get blocks
const CREATE_DELAY = 50; // ms; coalesces bursts of refreshes

/** Per-kind look, chip text and buttons ([action, label, tooltip, css class]). */
const KIND = {
  mine: {
    bg: '--vscode-diffEditor-removedLineBackground',
    fallback: 'rgba(255, 0, 0, 0.2)',
    prefix: '−',
    tag: (label) => `yours · not on ${label}`,
    empty: (label, n) => `yours · ${n} new line${n > 1 ? 's' : ''} not on ${label}`,
    buttons: [
      ['reject', 'Reject', 'Put back the remote lines (Ctrl+N)', 'danger'],
      ['accept', 'Accept', 'Keep my version and hide this change (Ctrl+Shift+Y)', 'ok'],
    ],
  },
  incoming: {
    bg: '--vscode-gitInlineDiff-incomingLineBackground',
    fallback: 'rgba(64, 166, 255, 0.2)',
    prefix: '+',
    tag: (label) => `incoming from ${label} · not pulled yet`,
    empty: (label, n) => `incoming · ${label} removed ${n} line${n > 1 ? 's' : ''} · not pulled yet`,
    buttons: [
      ['reject', 'Accept incoming', 'Apply the remote lines (Ctrl+N)', 'info'],
      ['accept', 'Dismiss', 'Hide this incoming change without touching the file (Ctrl+Shift+Y)', 'plain'],
    ],
  },
  conflict: {
    bg: '--vscode-gitInlineDiff-conflictLineBackground',
    fallback: 'rgba(210, 153, 34, 0.2)',
    prefix: '⇄',
    tag: (label) => `conflict · you and ${label} both changed this`,
    empty: (label) => `conflict · ${label} removed these lines, you changed them`,
    buttons: [
      ['accept', 'Accept current', 'Keep my version and hide this conflict (Ctrl+Shift+Y)', 'ok'],
      ['reject', 'Accept incoming', 'Replace my lines with the remote lines (Ctrl+N)', 'info'],
      ['both', 'Accept both', 'Insert the remote lines above mine, then merge by hand', 'plain'],
    ],
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rows of the block above the hunk. A conflict adds two header rows: "incoming" above theirs, "current" above mine. */
function rowsFor(lines, kind) {
  const n = Math.min(lines.length, MAX_ROWS) + (lines.length > MAX_ROWS ? 1 : 0);
  if (kind === 'conflict') return n ? n + 2 : 1;
  return n;
}

const BAR_ROWS = 2; // chip row, buttons row (a small gap between them, not a whole line)

const BASE_CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--vscode-editor-background,#1e1e1e);}
body{font-family:var(--vscode-editor-font-family,Consolas,monospace);font-size:var(--vscode-editor-font-size,14px);font-weight:var(--vscode-editor-font-weight,normal);color:var(--vscode-editor-foreground,#d4d4d4);}
.w{display:flex;flex-direction:column;height:100%;}
.l{flex:1 1 0;min-height:0;display:flex;align-items:center;white-space:pre;overflow:hidden;}`;

/**
 * The other side's lines, one row each. For a conflict the remote lines are shown in the incoming colour under an
 * "incoming" header, and a "current · yours" header sits right above my (orange) lines, so both sides are named.
 */
function rowsHtml(kind, lines, tabSize, label) {
  const k = KIND[kind] || KIND.mine;
  const conflict = kind === 'conflict';
  const prefix = conflict ? '+' : k.prefix;
  const rows = [];
  if (conflict) {
    rows.push(`<div class="l h theirs"><span class="p">↓</span><span class="t">${lines.length ? `incoming from ${escapeHtml(label)}` : `incoming from ${escapeHtml(label)} · these lines were removed there`}</span></div>`);
  }
  for (const l of lines.slice(0, MAX_ROWS)) rows.push(`<div class="l${conflict ? ' theirs' : ''}"><span class="p">${prefix}</span><span class="t">${escapeHtml(l) || ' '}</span></div>`);
  if (lines.length > MAX_ROWS) rows.push(`<div class="l${conflict ? ' theirs' : ''}"><span class="p"> </span><span class="t more">… ${lines.length - MAX_ROWS} more line(s): hover the hunk or open the diff</span></div>`);
  if (conflict && lines.length) rows.push(`<div class="l h"><span class="p">↓</span><span class="t">current · yours</span></div>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${BASE_CSS}
.l{tab-size:${tabSize};background:var(${k.bg},${k.fallback});}
.l.theirs{background:var(${KIND.incoming.bg},${KIND.incoming.fallback});}
.h .t{font-size:.8em;font-style:italic;opacity:.9;letter-spacing:.02em;}
.p{display:inline-block;width:1.6em;text-align:center;opacity:.7;flex:none;}
.t{flex:1 1 auto;min-width:0;}
.more{opacity:.7;font-style:italic;}
</style></head><body><div class="w">${rows.join('')}</div></body></html>`;
}

/** Chip + buttons, packed to the left. */
function barHtml(kind, o) {
  const k = KIND[kind] || KIND.mine;
  const nonce = crypto.randomBytes(12).toString('hex');
  const tag = o.hasLines ? k.tag(o.label) : k.empty(o.label, o.newCount);
  const buttons =
    k.buttons.map(([a, t, tip, cls]) => `<button class="b ${cls}" data-a="${a}" title="${escapeHtml(tip)}">${escapeHtml(t)}</button>`).join('') +
    `<button class="b plain" data-a="diff" title="Open in the diff editor">⧉ diff</button>` +
    `<span class="sep"></span><span class="pos" id="pos">${o.index} / ${o.total}</span>` +
    `<button class="b nav" data-a="prev" title="Previous change (Shift+F7)">↑</button>` +
    `<button class="b nav" data-a="next" title="Next change (F7)">↓</button>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${BASE_CSS}
.l{gap:6px;padding:0 8px 0 6px;background:var(${k.bg},${k.fallback});filter:brightness(1.12);}
.top{flex:0 0 auto;padding-top:2px;}
.bottom{flex:1 1 auto;align-items:flex-start;padding-top:4px;overflow:visible;}
.tag{flex:none;font-size:.74em;opacity:.85;padding:0 7px;border:1px solid currentColor;border-radius:9px;line-height:1.4;white-space:nowrap;}
.b{flex:none;box-sizing:border-box;font:inherit;font-size:.78em;line-height:1.35;padding:0 8px;border:1px solid transparent;border-radius:4px;cursor:pointer;white-space:nowrap;
  color:var(--vscode-editor-foreground,#d4d4d4);background:var(--vscode-button-secondaryBackground,#3a3d41);}
.b:hover{filter:brightness(1.25);}
.b.plain{border-color:rgba(128,128,128,.55);background:transparent;}
.b.ok{background:var(--vscode-diffEditor-insertedTextBackground,rgba(46,160,67,.4));}
.b.danger{background:var(--vscode-diffEditor-removedTextBackground,rgba(248,81,73,.4));}
.b.info{background:var(--vscode-gitInlineDiff-incomingTextBackground,rgba(64,166,255,.4));}
.b.nav{padding:0 6px;border-color:rgba(128,128,128,.55);background:transparent;}
.sep{flex:none;width:1px;height:1.1em;margin:0 4px;background:rgba(128,128,128,.5);}
.pos{flex:none;font-size:.74em;opacity:.75;white-space:nowrap;}
</style></head><body><div class="w"><div class="l top"><span class="tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span></div><div class="l bottom">${buttons}</div></div>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
for (const b of document.querySelectorAll('button[data-a]')) b.addEventListener('click', (e) => { e.preventDefault(); api.postMessage({ action: b.dataset.a }); });
window.addEventListener('message', (e) => { const m = e.data; if (m && m.type === 'pos') document.getElementById('pos').textContent = m.index + ' / ' + m.total; });
</script></body></html>`;
}

class InsetRenderer {
  /**
   * @param {{log: (msg: any) => void, onUnavailable: (err: Error) => void, onAction: (uri: vscode.Uri, hunkId: string, action: string) => void}} o
   */
  constructor(o) {
    this.log = o.log;
    this.onUnavailable = o.onUnavailable;
    this.onAction = o.onAction;
    this.available = typeof vscode.window.createWebviewTextEditorInset === 'function';
    this.reported = false;
    /** @type {Map<vscode.TextEditor, Map<string, {insets: any[], key: string}>>} */
    this.byEditor = new Map();
    /** @type {Map<vscode.TextEditor, NodeJS.Timeout>} */
    this.timers = new Map();
  }

  /** Line after which the rows block goes (-1 = top of the file). */
  static rowsAfter(h, lineCount) {
    if (h.newCount > 0) return h.newStart - 1;
    if (h.newStart >= lineCount) return lineCount - 1; // removed block was at the very end
    return markerLine(h, lineCount) - 1;
  }

  /** Line after which the action bar goes: below my lines, or right below the rows when I have none. */
  static barAfter(h, lineCount) {
    if (h.newCount > 0) return Math.min(h.newStart + h.newCount - 1, lineCount - 1);
    return InsetRenderer.rowsAfter(h, lineCount);
  }

  /**
   * Make the blocks of `editor` match `hunks`. Blocks of unchanged hunks at the same place are kept;
   * the rest are disposed and new ones created after a short delay.
   * @param {{label: string, tabSize: number}} ctx
   */
  sync(editor, hunks, ctx) {
    let map = this.byEditor.get(editor);
    if (!map) {
      map = new Map();
      this.byEditor.set(editor, map);
    }
    const lineCount = editor.document.lineCount;
    const wanted = new Map();
    const shown = hunks.slice(0, MAX_INSETS);
    shown.forEach((h, i) => {
      const rowsAfter = InsetRenderer.rowsAfter(h, lineCount);
      const barAfter = InsetRenderer.barAfter(h, lineCount);
      const rows = rowsFor(h.oldLines, h.kind);
      // index / total are NOT part of the key: they change on every accept and are pushed to the live bars instead
      wanted.set(h.id, { key: `${rowsAfter}|${rows}|${barAfter}|${ctx.label}`, rowsAfter, rows, barAfter, kind: h.kind, lines: h.oldLines, newCount: h.newCount, label: ctx.label, index: i + 1, total: shown.length });
    });
    for (const [id, e] of map) {
      const w = wanted.get(id);
      if (!w || w.key !== e.key) {
        for (const i of e.insets) {
          try {
            i.dispose();
          } catch {
            /* already gone */
          }
        }
        map.delete(id);
      } else if (e.bar) {
        this.postPosition(e.bar, w.index, w.total);
      }
    }
    const t = this.timers.get(editor);
    if (t) clearTimeout(t);
    const toCreate = [...wanted].filter(([id]) => !map.has(id));
    if (!toCreate.length) {
      this.timers.delete(editor);
      if (!map.size) this.byEditor.delete(editor);
      return;
    }
    this.timers.set(
      editor,
      setTimeout(() => {
        this.timers.delete(editor);
        for (const [id, w] of toCreate) {
          if (!this.available) break;
          if (!map.has(id)) this.create(editor, map, id, w, ctx);
        }
      }, CREATE_DELAY)
    );
  }

  create(editor, map, id, w, ctx) {
    const insets = [];
    const entry = { insets, key: w.key };
    try {
      // rows first, then the bar: two zones after the same line keep their creation order (deletions)
      if (w.rows > 0) {
        const rows = vscode.window.createWebviewTextEditorInset(editor, w.rowsAfter, w.rows, { enableScripts: false });
        rows.webview.html = rowsHtml(w.kind, w.lines, ctx.tabSize, w.label);
        insets.push(rows);
      }
      // two rows: the kind chip, then the buttons on a line of their own, with a small gap between them
      const bar = vscode.window.createWebviewTextEditorInset(editor, w.barAfter, BAR_ROWS, { enableScripts: true });
      bar.webview.html = barHtml(w.kind, { label: w.label, newCount: w.newCount, hasLines: w.lines.length > 0, index: w.index, total: w.total });
      bar.webview.onDidReceiveMessage((msg) => {
        if (msg && typeof msg.action === 'string') this.onAction(editor.document.uri, id, msg.action);
      });
      insets.push(bar);
      entry.bar = bar;
      map.set(id, entry);
      for (const i of insets) {
        i.onDidDispose(() => {
          if (map.get(id) !== entry) return;
          // one half went away (editor closed, zone removed): drop the other half too
          map.delete(id);
          for (const other of insets) {
            if (other !== i) {
              try {
                other.dispose();
              } catch {
                /* already gone */
              }
            }
          }
        });
      }
    } catch (err) {
      for (const i of insets) {
        try {
          i.dispose();
        } catch {
          /* ignore */
        }
      }
      this.log(err);
      if (/CANNOT use|proposed/i.test(String(err && err.message))) {
        // the proposal is not enabled for this extension: give up on blocks for this session
        this.available = false;
        this.disposeAll();
        if (!this.reported) {
          this.reported = true;
          this.onUnavailable(err);
        }
      }
      // any other error (e.g. the editor is no longer visible) just skips this hunk for now
    }
  }

  /** Update the "2 / 5" counter of a live bar without rebuilding its webview. */
  postPosition(bar, index, total) {
    try {
      const r = bar.webview.postMessage({ type: 'pos', index, total });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* bar gone */
    }
  }

  clear(editor) {
    const t = this.timers.get(editor);
    if (t) clearTimeout(t);
    this.timers.delete(editor);
    const map = this.byEditor.get(editor);
    if (!map) return;
    this.byEditor.delete(editor);
    for (const e of map.values()) {
      for (const i of e.insets) {
        try {
          i.dispose();
        } catch {
          /* already gone */
        }
      }
    }
  }

  disposeAll() {
    for (const editor of [...this.byEditor.keys()]) this.clear(editor);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  dispose() {
    this.disposeAll();
  }
}

module.exports = { InsetRenderer, rowsHtml, barHtml, MAX_INSETS };
