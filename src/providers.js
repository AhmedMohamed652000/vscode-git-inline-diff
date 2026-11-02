'use strict';

const vscode = require('vscode');
const git = require('./git');
const { firstLine } = require('./diff');
const { cfg } = require('./controller');

const BASE_SCHEME = 'git-inline-diff';
const MAX_HOVER_LINES = 80;

/** Uri whose content is the base version of the file (served by BaseContentProvider). */
function baseUri(st) {
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: st.uri.path,
    query: JSON.stringify({ root: st.root, sha: st.sha || '', label: st.label || '' }),
  });
}

class BaseContentProvider {
  async provideTextDocumentContent(uri) {
    let q;
    try {
      q = JSON.parse(uri.query || '{}');
    } catch {
      return '';
    }
    if (!q.sha || !q.root) return '';
    try {
      return await git.catBlob(q.root, q.sha);
    } catch (err) {
      return `// Hunkly could not read ${q.label || 'the base'}: ${err.message}`;
    }
  }
}

function stat(h) {
  const minus = h.oldLines.length;
  const plus = h.newCount;
  return `${minus ? '-' + minus : ''}${minus && plus ? ' ' : ''}${plus ? '+' + plus : ''}`;
}

/** [title, tooltip, command] triples per hunk kind. */
function lensSpecs(h, label) {
  switch (h.kind) {
    case 'incoming':
      return [
        ['$(cloud-download) Accept incoming', `Apply the ${label} version of these lines (Ctrl+N)`, 'gitInlineDiff.rejectHunk'],
        ['$(eye-closed) Dismiss', 'Hide this incoming change without touching the file (Ctrl+Shift+Y)', 'gitInlineDiff.acceptHunk'],
        [`$(arrow-down) incoming from ${label} · pull to merge`, 'This change is on the remote but not in your HEAD yet. Open it in the diff editor.', 'gitInlineDiff.openDiff'],
      ];
    case 'conflict':
      return [
        ['$(check) Accept current', 'Keep my version and hide this conflict (Ctrl+Shift+Y)', 'gitInlineDiff.acceptHunk'],
        ['$(cloud-download) Accept incoming', `Replace my lines with the ${label} version (Ctrl+N)`, 'gitInlineDiff.rejectHunk'],
        ['$(combine) Accept both', `Insert the ${label} lines above mine, then merge by hand`, 'gitInlineDiff.keepBoth'],
        [`$(warning) ${stat(h)} conflicts with ${label}`, 'Both you and the remote changed this region since the merge base. Open it in the diff editor.', 'gitInlineDiff.openDiff'],
      ];
    default:
      return [
        ['$(check) Accept', 'Keep my version and hide this change (Ctrl+Shift+Y)', 'gitInlineDiff.acceptHunk'],
        ['$(close) Reject', `Put back the ${label} version of these lines (Ctrl+N)`, 'gitInlineDiff.rejectHunk'],
        [`$(git-compare) ${stat(h)} vs ${label}`, 'Open this change in the diff editor', 'gitInlineDiff.openDiff'],
      ];
  }
}

class HunkCodeLensProvider {
  constructor(controller) {
    this.controller = controller;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChange.event;
    this.sub = controller.onDidChange(() => this._onDidChange.fire());
  }

  dispose() {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  provideCodeLenses(doc) {
    const st = this.controller.getState(doc.uri);
    if (!st || st.kind !== 'ok' || st.version !== doc.version || !cfg().get('showCodeLens', true)) return [];
    if (this.controller.rowsActive()) return []; // the buttons live inside the row block
    const label = st.label || 'base';
    const lenses = [];
    for (const h of this.controller.pending(st)) {
      const line = firstLine(h, doc.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [doc.uri.toString(), h.id];
      for (const [title, tooltip, command] of lensSpecs(h, label)) {
        lenses.push(new vscode.CodeLens(range, { title, tooltip, command, arguments: args }));
      }
    }
    return lenses;
  }
}

function block(prefix, lines) {
  return lines.map((l) => prefix + l);
}

class HunkHoverProvider {
  constructor(controller) {
    this.controller = controller;
  }

  provideHover(doc, position) {
    const st = this.controller.getState(doc.uri);
    const hunk = this.controller.hunkAt(doc, position.line);
    if (!st || !hunk) return undefined;
    const label = st.label || 'base';
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;

    let lines;
    let actions;
    if (hunk.kind === 'incoming') {
      md.appendMarkdown(`**Incoming from \`${label}\`** · on the remote, not in your HEAD yet (pull to merge)  \n`);
      lines = [...block('- ', hunk.newLines), ...block('+ ', hunk.oldLines)];
      actions = [
        ['$(cloud-download) Accept incoming', 'gitInlineDiff.rejectHunk', `Apply the ${label} version`],
        ['$(eye-closed) Dismiss', 'gitInlineDiff.acceptHunk', 'Hide this incoming change'],
      ];
    } else if (hunk.kind === 'conflict') {
      md.appendMarkdown(`**Conflict with \`${label}\`** · both sides changed this region since the merge base  \n`);
      lines = [...block('- ', hunk.baseLines), ...block('+ ', hunk.newLines)];
      actions = [
        ['$(check) Accept current', 'gitInlineDiff.acceptHunk', 'Keep my version'],
        ['$(cloud-download) Accept incoming', 'gitInlineDiff.rejectHunk', `Replace my lines with the ${label} version`],
        ['$(combine) Accept both', 'gitInlineDiff.keepBoth', `Insert the ${label} lines above mine`],
      ];
    } else {
      md.appendMarkdown(`**Hunkly** · vs \`${label}\`  \n`);
      lines = [...block('- ', hunk.oldLines), ...block('+ ', hunk.newLines)];
      actions = [
        ['$(check) Accept', 'gitInlineDiff.acceptHunk', 'Keep my version'],
        ['$(close) Reject', 'gitInlineDiff.rejectHunk', `Restore the ${label} version`],
      ];
    }
    let body = lines.slice(0, MAX_HOVER_LINES).join('\n');
    if (lines.length > MAX_HOVER_LINES) body += `\n… ${lines.length - MAX_HOVER_LINES} more line(s)`;
    md.appendCodeblock(body, 'diff');
    if (hunk.kind === 'conflict') {
      md.appendMarkdown(`theirs (\`${label}\`):  \n`);
      const theirs = block('+ ', hunk.oldLines);
      md.appendCodeblock(theirs.slice(0, MAX_HOVER_LINES).join('\n') || '(deleted)', 'diff');
    }

    const args = encodeURIComponent(JSON.stringify([doc.uri.toString(), hunk.id]));
    actions.push(['$(git-compare) Open diff', 'gitInlineDiff.openDiff', 'Open in the diff editor']);
    md.appendMarkdown(actions.map(([title, command, tip]) => `[${title}](command:${command}?${args} "${tip}")`).join(' · '));

    const start = firstLine(hunk, doc.lineCount);
    const end = Math.max(start, start + hunk.newCount - 1);
    return new vscode.Hover(md, new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
  }
}

function registerProviders(controller) {
  const selector = [{ scheme: 'file' }];
  const codeLens = new HunkCodeLensProvider(controller);
  return [
    codeLens,
    vscode.languages.registerCodeLensProvider(selector, codeLens),
    vscode.languages.registerHoverProvider(selector, new HunkHoverProvider(controller)),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider()),
  ];
}

module.exports = { registerProviders, baseUri, BASE_SCHEME };
