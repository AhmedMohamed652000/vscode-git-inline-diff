'use strict';

const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { firstLine, lastLine } = require('./diff');
const { cfg, describeHunks } = require('./controller');
const { baseUri, BASE_SCHEME } = require('./providers');
const { argvPathFor, enableProposedApi } = require('./argv');

/**
 * Resolve the document / hunk a command should act on.
 * CodeLens and hover links pass (uriString, hunkId); keybindings and the palette pass nothing (use the cursor).
 */
async function target(controller, uriArg, hunkId) {
  let doc;
  let editor;
  if (uriArg) {
    const uri = typeof uriArg === 'string' ? vscode.Uri.parse(uriArg) : uriArg;
    doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
  } else {
    editor = vscode.window.activeTextEditor;
    doc = editor && editor.document;
  }
  if (!doc) return {};
  let st = controller.getState(doc.uri);
  if (!st || st.version !== doc.version) st = await controller.refresh(doc);
  let hunk;
  if (hunkId) hunk = st.hunks.find((h) => h.id === hunkId && !st.accepted.has(h.id));
  else if (editor) hunk = controller.hunkAt(doc, editor.selection.active.line);
  return { doc, st, hunk, editor };
}

function noHunk() {
  vscode.window.setStatusBarMessage('Git Inline Diff: no change under the cursor', 2500);
}

function sortedPending(controller, st, lineCount) {
  return controller.pending(st).slice().sort((a, b) => firstLine(a, lineCount) - firstLine(b, lineCount));
}

function revealHunk(editor, hunk) {
  const doc = editor.document;
  const line = firstLine(hunk, doc.lineCount);
  const end = lastLine(hunk, doc.lineCount);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(line, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** After Accept / Reject: move the cursor to the next pending hunk so the file can be reviewed from the keyboard. */
function advanceAfter(controller, doc, fromLine) {
  if (!cfg().get('advanceAfterAction', true)) return;
  const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
  const st = controller.getState(doc.uri);
  if (!editor || !st || st.kind !== 'ok') return;
  const hunks = sortedPending(controller, st, doc.lineCount);
  if (!hunks.length) {
    vscode.window.setStatusBarMessage(`$(check) Git Inline Diff: ${path.basename(doc.fileName)} reviewed`, 3000);
    return;
  }
  const next = hunks.find((h) => firstLine(h, doc.lineCount) >= fromLine) || hunks[0];
  revealHunk(editor, next);
}

async function repoRootFor(doc) {
  if (doc && doc.uri.scheme === 'file') {
    const root = await git.repoRoot(path.dirname(doc.uri.fsPath));
    if (root) return root;
  }
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    if (f.uri.scheme !== 'file') continue;
    const root = await git.repoRoot(f.uri.fsPath);
    if (root) return root;
  }
  return null;
}

function registerCommands(controller) {
  const reg = (id, fn) =>
    vscode.commands.registerCommand(id, async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        controller.log(err);
        vscode.window.showErrorMessage(`Git Inline Diff: ${err.message || err}`);
      }
    });

  return [
    reg('gitInlineDiff.acceptHunk', async (uriArg, hunkId) => {
      const { doc, hunk } = await target(controller, uriArg, hunkId);
      if (!doc || !hunk) return noHunk();
      const from = firstLine(hunk, doc.lineCount);
      controller.accept(doc, [hunk]);
      advanceAfter(controller, doc, from);
    }),

    reg('gitInlineDiff.rejectHunk', async (uriArg, hunkId) => {
      const { doc, hunk } = await target(controller, uriArg, hunkId);
      if (!doc || !hunk) return noHunk();
      const from = firstLine(hunk, doc.lineCount);
      await controller.reject(doc, [hunk]);
      advanceAfter(controller, doc, from);
    }),

    reg('gitInlineDiff.keepBoth', async (uriArg, hunkId) => {
      const { doc, hunk } = await target(controller, uriArg, hunkId);
      if (!doc || !hunk) return noHunk();
      if (hunk.kind !== 'conflict') {
        vscode.window.setStatusBarMessage('Git Inline Diff: "Accept both" is for conflicts only', 2500);
        return;
      }
      const from = firstLine(hunk, doc.lineCount);
      await controller.keepBoth(doc, hunk);
      advanceAfter(controller, doc, from);
    }),

    reg('gitInlineDiff.acceptAll', async (uriArg) => {
      const { doc, st } = await target(controller, uriArg);
      if (!doc || !st || st.kind !== 'ok') return;
      controller.accept(doc, controller.pending(st));
    }),

    reg('gitInlineDiff.rejectAll', async (uriArg) => {
      const { doc, st } = await target(controller, uriArg);
      if (!doc || !st || st.kind !== 'ok') return;
      const pending = controller.pending(st);
      if (!pending.length) return;
      const what = st.threeWay ? describeHunks(pending).text : `${pending.length} change(s)`;
      const answer = await vscode.window.showWarningMessage(
        `Replace ${what} in ${path.basename(doc.fileName)} with the ${st.label} version? (Ctrl+Z undoes it)`,
        { modal: true },
        'Reject all'
      );
      if (answer !== 'Reject all') return;
      await controller.reject(doc, pending);
    }),

    reg('gitInlineDiff.nextHunk', async () => {
      const { doc, st, editor } = await target(controller);
      if (!doc || !st || !editor || st.kind !== 'ok') return;
      const hunks = sortedPending(controller, st, doc.lineCount);
      if (!hunks.length) return noHunk();
      const line = editor.selection.active.line;
      const next = hunks.find((h) => firstLine(h, doc.lineCount) > line) || hunks[0];
      revealHunk(editor, next);
    }),

    reg('gitInlineDiff.previousHunk', async () => {
      const { doc, st, editor } = await target(controller);
      if (!doc || !st || !editor || st.kind !== 'ok') return;
      const hunks = sortedPending(controller, st, doc.lineCount);
      if (!hunks.length) return noHunk();
      const line = editor.selection.active.line;
      const prev = hunks.slice().reverse().find((h) => lastLine(h, doc.lineCount) < line) || hunks[hunks.length - 1];
      revealHunk(editor, prev);
    }),

    reg('gitInlineDiff.openDiff', async (uriArg, hunkId) => {
      const { doc, st, hunk, editor } = await target(controller, uriArg, hunkId);
      if (!doc || !st || !st.root) return vscode.window.showInformationMessage('Git Inline Diff: this file is not inside a git repository.');
      if (st.kind === 'error') return vscode.window.showWarningMessage(`Git Inline Diff: ${st.error}`);
      let selection;
      const focus = hunk || (editor && controller.hunkAt(doc, editor.selection.active.line)) || sortedPending(controller, st, doc.lineCount)[0];
      if (focus) {
        const line = firstLine(focus, doc.lineCount);
        selection = new vscode.Range(line, 0, line, 0);
      }
      const title = `${path.basename(doc.fileName)} (${st.label} ↔ Working Tree)`;
      await vscode.commands.executeCommand('vscode.diff', baseUri(st), doc.uri, title, { preview: true, selection });
    }),

    reg('gitInlineDiff.showBase', async (uriArg) => {
      const { doc, st } = await target(controller, uriArg);
      if (!doc || !st || !st.root) return vscode.window.showInformationMessage('Git Inline Diff: this file is not inside a git repository.');
      await vscode.window.showTextDocument(baseUri(st), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),

    reg('gitInlineDiff.reviewAll', async () => {
      const ed = vscode.window.activeTextEditor;
      const root = await repoRootFor(ed && ed.document);
      if (!root) return vscode.window.showInformationMessage('Git Inline Diff: no git repository found.');
      const base = await git.resolveBase(root, cfg().get('base', 'upstream'));
      if (!(await git.refExists(root, base.ref))) return vscode.window.showWarningMessage(`Git Inline Diff: ref "${base.ref}" not found.`);
      const files = await git.changedFiles(root, base.ref);
      const deleted = [];
      const list = [];
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Git Inline Diff: collecting changes vs ${base.label}` }, async () => {
        for (const f of files) {
          if (f.status === 'D') {
            deleted.push(f.path);
            continue;
          }
          const abs = path.join(root, f.path);
          const modified = vscode.Uri.file(abs);
          const sha = f.status === '?' ? null : await git.blobSha(root, base.ref, f.oldPath || f.path);
          const original = vscode.Uri.from({ scheme: BASE_SCHEME, path: modified.path, query: JSON.stringify({ root, sha: sha || '', label: base.label }) });
          list.push([modified, original, modified]);
        }
      });
      if (!list.length && !deleted.length) return vscode.window.showInformationMessage(`Git Inline Diff: no changes vs ${base.label}.`);
      if (list.length) await vscode.commands.executeCommand('vscode.changes', `Changes vs ${base.label}`, list);
      if (deleted.length) vscode.window.showInformationMessage(`Git Inline Diff: ${deleted.length} file(s) deleted locally are not shown: ${deleted.slice(0, 5).join(', ')}${deleted.length > 5 ? '…' : ''}`);
    }),

    reg('gitInlineDiff.enableInlineRows', async () => {
      const extId = (controller.context.extension && controller.context.extension.id) || 'Ghammes.git-inline-diff';
      const argvPath = argvPathFor(vscode.env.appRoot);
      const res = enableProposedApi(argvPath, extId);
      const app = vscode.env.appName;
      if (res.changed) {
        vscode.window.showInformationMessage(
          `Git Inline Diff: "enable-proposed-api": ["${extId}"] was added to ${argvPath} (backup: argv.json.bak). Quit ${app} completely and start it again; removed lines then show as rows.`
        );
      } else {
        vscode.window.showInformationMessage(`Git Inline Diff: ${argvPath} already enables the proposed API for ${extId}. Quit ${app} completely and start it again if the rows do not show.`);
      }
    }),

    reg('gitInlineDiff.refresh', async () => {
      controller.baseCache.clear();
      controller.refreshVisible(true);
    }),

    reg('gitInlineDiff.fetchAndRefresh', async () => {
      const ed = vscode.window.activeTextEditor;
      const root = await repoRootFor(ed && ed.document);
      if (!root) return vscode.window.showInformationMessage('Git Inline Diff: no git repository found.');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Git Inline Diff: git fetch (${path.basename(root)})` }, () => git.fetch(root));
      controller.baseCache.clear();
      controller.refreshVisible(true);
    }),

    reg('gitInlineDiff.resetAccepted', async (uriArg) => {
      const { doc } = await target(controller, uriArg);
      if (doc) controller.resetAccepted(doc);
    }),

    reg('gitInlineDiff.chooseBase', async () => {
      const current = cfg().get('base', 'upstream');
      const items = [
        { label: '$(cloud) upstream', description: 'remote tracking branch — what is on GitHub (origin/<branch>)', value: 'upstream' },
        { label: '$(git-commit) head', description: 'last local commit', value: 'head' },
        { label: '$(list-selection) index', description: 'staged version', value: 'index' },
        { label: '$(edit) custom ref…', description: 'e.g. origin/main, main, v1.2.0, a commit sha', value: 'custom' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Compare open files against… (current: ${current})` });
      if (!pick) return;
      let value = pick.value;
      if (value === 'custom') {
        value = await vscode.window.showInputBox({ prompt: 'Git ref to compare against', value: current === 'upstream' || current === 'head' || current === 'index' ? '' : current, placeHolder: 'origin/main' });
        if (!value) return;
        value = value.trim();
      }
      const hasWorkspace = (vscode.workspace.workspaceFolders || []).length > 0;
      await cfg().update('base', value, hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }),

    reg('gitInlineDiff.toggle', async () => {
      const enabled = cfg().get('enabled', true);
      await cfg().update('enabled', !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Git Inline Diff ${enabled ? 'disabled' : 'enabled'}`, 2500);
    }),

    reg('gitInlineDiff.showMenu', async () => {
      const ed = vscode.window.activeTextEditor;
      const st = ed && controller.getState(ed.document.uri);
      const label = (st && st.label) || 'base';
      const pending = st && st.kind === 'ok' ? controller.pending(st).length : 0;
      const accepted = st ? st.accepted.size : 0;
      const items = [
        { label: '$(git-compare) Open diff against ' + label, description: 'Cursor-like inline view (set diffEditor.renderSideBySide = false)', command: 'gitInlineDiff.openDiff' },
        { label: '$(files) Review all changed files', description: `every file that differs from ${label}`, command: 'gitInlineDiff.reviewAll' },
        { label: '$(eye) Open base version', description: `${label} read-only, side by side`, command: 'gitInlineDiff.showBase' },
        ...(pending ? [{ label: `$(check-all) Accept all (${pending})`, description: 'keep my version, hide the highlights', command: 'gitInlineDiff.acceptAll' }] : []),
        ...(pending ? [{ label: `$(discard) Reject all (${pending})`, description: `restore the ${label} version of this file`, command: 'gitInlineDiff.rejectAll' }] : []),
        ...(accepted ? [{ label: `$(history) Show ${accepted} accepted hunk(s) again`, command: 'gitInlineDiff.resetAccepted' }] : []),
        { label: '$(cloud-download) Fetch remote and refresh', description: 'git fetch, then compare again', command: 'gitInlineDiff.fetchAndRefresh' },
        { label: '$(refresh) Refresh', command: 'gitInlineDiff.refresh' },
        { label: '$(settings-gear) Compare against…', description: `current: ${cfg().get('base', 'upstream')}`, command: 'gitInlineDiff.chooseBase' },
        { label: `$(circle-slash) ${cfg().get('enabled', true) ? 'Disable' : 'Enable'} Git Inline Diff`, command: 'gitInlineDiff.toggle' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Git Inline Diff' });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
  ];
}

module.exports = { registerCommands };
