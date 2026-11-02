'use strict';
// Exercises the extension against a throw-away git repository using a fake `vscode` module.
// Usage: node test/smoke.js [path-to-a-real-file-in-a-git-repo]

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { makeVscode } = require('./fakeVscode');

const vscode = makeVscode();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const { activate } = require('../extension');

const store = {};
const context = {
  subscriptions: [],
  workspaceState: { get: (k, d) => (k in store ? store[k] : d), update: async (k, v) => void (store[k] = v) },
};
const { controller } = activate(context);

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function openDoc(fsPath, text, eol) {
  const doc = new vscode.TextDocument(fsPath, text, eol);
  const editor = new vscode.TextEditor(doc);
  vscode.workspace.textDocuments = [doc];
  vscode.window.visibleTextEditors = [editor];
  vscode.window.activeTextEditor = editor;
  return { doc, editor };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-inline-diff-'));
  git(tmp, 'init', '-q');
  vscode.config.base = 'head';
  vscode.config.removedLinesView = 'inline'; // chips + CodeLens for the first scenarios; rows are tested at the end

  // ---- main scenario: CRLF file, one change, one deletion, one insertion
  const CRLF = '\r\n';
  const baseLines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const baseText = baseLines.join(CRLF) + CRLF;
  const file = path.join(tmp, 'a.js');
  fs.writeFileSync(file, baseText);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'base');

  const docLines = baseLines.slice();
  docLines[5] = 'line 5 changed';
  docLines.splice(10, 2); // remove line 10, line 11
  docLines.splice(19, 0, 'new A', 'new B'); // insert after what is now line 18 (base line 20)
  const { doc, editor } = openDoc(file, docLines.join(CRLF) + CRLF, vscode.EndOfLine.CRLF);

  let st = await controller.refresh(doc);
  assert.strictEqual(st.kind, 'ok', JSON.stringify(st.error || st.kind));
  assert.strictEqual(st.label, 'HEAD');
  assert.strictEqual(st.hunks.length, 3, 'expected 3 hunks, got ' + JSON.stringify(st.hunks));
  const [h1, h2, h3] = st.hunks;
  assert.deepStrictEqual([h1.oldStart, h1.oldLines, h1.newStart, h1.newLines], [5, ['line 5'], 5, ['line 5 changed']]);
  assert.deepStrictEqual([h2.oldStart, h2.oldLines, h2.newStart, h2.newCount], [10, ['line 10', 'line 11'], 10, 0]);
  assert.deepStrictEqual([h3.oldStart, h3.oldLines, h3.newStart, h3.newLines], [21, [], 19, ['new A', 'new B']]);

  // decorations
  const d = controller.decor;
  const added = editor.decorations.get(d.mine.line.key);
  assert.strictEqual(added.length, 2);
  assert.deepStrictEqual([added[0].start.line, added[0].end.line, added[1].start.line, added[1].end.line], [5, 5, 19, 20]);
  const top = editor.decorations.get(d.mine.top.key);
  assert.strictEqual(top.length, 1);
  assert.strictEqual(top[0].start.line, 10);
  const removedText = editor.decorations.get(d.mine.text.key);
  const byLine = Object.fromEntries(removedText.map((x) => [x.range.start.line, x.renderOptions.after.contentText]));
  assert.strictEqual(byLine[5], '− line 5');
  assert.strictEqual(byLine[10], '− line 10 ⏎ line 11');

  // code lens + hover
  const lenses = vscode.providers.codeLens.provideCodeLenses(doc);
  assert.strictEqual(lenses.length, 9);
  assert.strictEqual(lenses[0].range.start.line, 5);
  assert.strictEqual(lenses[3].range.start.line, 10);
  assert.strictEqual(lenses[6].range.start.line, 19);
  const hover = vscode.providers.hover.provideHover(doc, new vscode.Position(20, 0));
  assert.ok(hover && hover.contents.value.includes('+ new A') && hover.contents.value.includes('command:gitInlineDiff.rejectHunk'));
  assert.strictEqual(vscode.providers.hover.provideHover(doc, new vscode.Position(7, 0)), undefined);

  // context keys follow the cursor
  editor.selection = new vscode.Selection(5, 0, 5, 0);
  controller.updateCursor(editor);
  assert.strictEqual(vscode.contextKeys['gitInlineDiff.hunkAtCursor'], true);
  assert.strictEqual(vscode.contextKeys['gitInlineDiff.hasHunks'], true);
  assert.strictEqual(editor.decorations.get(d.hint.key).length, 1);
  editor.selection = new vscode.Selection(7, 0, 7, 0);
  controller.updateCursor(editor);
  assert.strictEqual(vscode.contextKeys['gitInlineDiff.hunkAtCursor'], false);
  editor.selection = new vscode.Selection(10, 0, 10, 0); // pure deletion marker line
  controller.updateCursor(editor);
  assert.strictEqual(vscode.contextKeys['gitInlineDiff.hunkAtCursor'], true);

  // accept through the command (as the CodeLens would call it) and make sure it is persisted
  await vscode.commands.executeCommand('gitInlineDiff.acceptHunk', doc.uri.toString(), h1.id);
  st = controller.getState(doc.uri);
  assert.strictEqual(controller.pending(st).length, 2);
  assert.deepStrictEqual(store['gitInlineDiff.accepted'][doc.uri.toString()], [h1.id]);
  controller.states.clear();
  st = await controller.refresh(doc);
  assert.strictEqual(controller.pending(st).length, 2, 'accepted hunk must survive a fresh state');

  // reject the two pending hunks through the keybinding path (cursor on the hunk)
  editor.selection = new vscode.Selection(19, 0, 19, 0);
  await vscode.commands.executeCommand('gitInlineDiff.rejectHunk');
  st = controller.getState(doc.uri);
  assert.strictEqual(controller.pending(st).length, 1);
  editor.selection = new vscode.Selection(10, 0, 10, 0);
  await vscode.commands.executeCommand('gitInlineDiff.rejectHunk');
  st = controller.getState(doc.uri);
  assert.strictEqual(controller.pending(st).length, 0);
  assert.strictEqual(doc.getText(), baseLines.map((l, i) => (i === 5 ? 'line 5 changed' : l)).join(CRLF) + CRLF);

  // show the accepted one again and reject it too -> identical to the committed file
  await vscode.commands.executeCommand('gitInlineDiff.resetAccepted');
  st = controller.getState(doc.uri);
  assert.strictEqual(controller.pending(st).length, 1);
  await vscode.commands.executeCommand('gitInlineDiff.rejectAll');
  assert.strictEqual(doc.getText(), baseText, 'rejecting everything must restore the committed text byte for byte');
  assert.strictEqual(controller.pending(controller.getState(doc.uri)).length, 0);

  // ---- end-of-file edge cases (LF)
  const cases = [
    ['eof1.txt', 'a\nb\n', 'a\nb'],
    ['eof2.txt', 'a\nb', 'a\nb\n'],
    ['eof3.txt', 'a\nb\nc', 'a\nX'],
    ['eof4.txt', 'a\nb\nc\n', 'a\nb\n'],
    ['eof5.txt', '', 'x\ny'],
    ['eof6.txt', 'a\n', ''],
    ['eof7.txt', 'a\nb\nc\n', 'a\nb\nc\nd\ne'],
    ['eof8.txt', 'a\nb', 'z\na\nb\nq'],
  ];
  for (const [name, base] of cases) fs.writeFileSync(path.join(tmp, name), base);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'eof cases');
  for (const [name, base, current] of cases) {
    const { doc: d2 } = openDoc(path.join(tmp, name), current, vscode.EndOfLine.LF);
    const s2 = await controller.refresh(d2);
    assert.strictEqual(s2.kind, 'ok', name);
    await controller.reject(d2, controller.pending(s2));
    assert.strictEqual(d2.getText(), base, `${name}: reject must restore the base exactly`);
    assert.strictEqual(controller.pending(controller.getState(d2.uri)).length, 0, name);
  }

  // ---- untracked file and a file outside any repo
  const { doc: d3 } = openDoc(path.join(tmp, 'untracked.txt'), 'hello', vscode.EndOfLine.LF);
  assert.strictEqual((await controller.refresh(d3)).kind, 'new');
  const outside = path.join(os.tmpdir(), 'git-inline-diff-outside.txt');
  fs.writeFileSync(outside, 'x');
  const { doc: d4 } = openDoc(outside, 'x', vscode.EndOfLine.LF);
  assert.strictEqual((await controller.refresh(d4)).kind, 'notgit');

  // ---- base content provider serves the committed text for the diff editor
  const { baseUri } = require('../src/providers');
  const stA = await controller.refresh(doc);
  const served = await vscode.providers.content.provideTextDocumentContent(baseUri(stA));
  assert.strictEqual(served, baseText);

  // ---- three-way: merge base (main) vs a remote branch vs the working copy
  const B = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  B[10] = 'const timeout = 5000;';
  const tFile = path.join(tmp, 't.js');
  fs.writeFileSync(tFile, B.join('\n') + '\n');
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 't base');
  git(tmp, 'checkout', '-q', '-b', 'remote');
  const R = B.slice();
  R[3] = 'line 3 theirs';
  R[15] = 'line 15 theirs';
  R.splice(26, 0, 'theirs new');
  const remoteText = R.join('\n') + '\n';
  fs.writeFileSync(tFile, remoteText);
  git(tmp, 'commit', '-q', '-am', 'theirs');
  git(tmp, 'checkout', '-q', '-'); // back to main == the merge base
  const Wl = B.slice();
  Wl[8] = 'line 8 mine';
  Wl[10] = 'const timeout = 8000;';
  Wl[15] = 'line 15 mine';
  Wl.splice(20, 1);
  vscode.config.base = 'remote';
  controller.states.clear();
  controller.baseCache.clear();
  controller.blobCache.clear();
  const { doc: td, editor: te } = openDoc(tFile, Wl.join('\n') + '\n', vscode.EndOfLine.LF);
  let ts = await controller.refresh(td);
  assert.strictEqual(ts.kind, 'ok', ts.error);
  assert.strictEqual(ts.threeWay, true, 'merge base must be detected');
  assert.deepStrictEqual(
    ts.hunks.map((h) => `${h.kind}@${h.newStart}`),
    ['incoming@3', 'mine@8', 'mine@10', 'conflict@15', 'mine@20', 'incoming@25'],
    JSON.stringify(ts.hunks)
  );
  const [inc, , , conf, del, ins] = ts.hunks;
  assert.deepStrictEqual([inc.oldLines, inc.newLines, inc.baseLines], [['line 3 theirs'], ['line 3'], ['line 3']]);
  assert.deepStrictEqual([conf.oldLines, conf.newLines, conf.baseLines], [['line 15 theirs'], ['line 15 mine'], ['line 15']]);
  assert.deepStrictEqual([del.oldLines, del.newCount], [['line 20'], 0]);
  assert.deepStrictEqual([ins.oldLines, ins.newLines, ins.newCount], [['theirs new'], [], 0]);
  assert.ok(/3 mine.*2 incoming.*1 conflict/.test(controller.status.text), controller.status.text);

  // decorations per kind (whole lines, no word-level diff)
  const dk = controller.decor;
  const linesOf = (type) => (te.decorations.get(type.key) || []).map((r) => r.start.line);
  assert.deepStrictEqual(linesOf(dk.incoming.line), [3]);
  assert.deepStrictEqual(linesOf(dk.incoming.top), [25]);
  assert.deepStrictEqual(linesOf(dk.conflict.line), [15]);
  assert.deepStrictEqual(linesOf(dk.mine.line), [8, 10]);
  assert.deepStrictEqual(linesOf(dk.mine.top), [20]);
  const textOf = (type) => Object.fromEntries((te.decorations.get(type.key) || []).map((x) => [x.range.start.line, x.renderOptions.after.contentText]));
  assert.strictEqual(textOf(dk.mine.text)[10], '− const timeout = 5000;');
  assert.strictEqual(textOf(dk.mine.text)[8], '− line 8');
  assert.strictEqual(textOf(dk.incoming.text)[3], '+ line 3 theirs');
  assert.strictEqual(textOf(dk.incoming.text)[25], '+ theirs new');
  assert.strictEqual(textOf(dk.conflict.text)[15], '⇄ line 15 theirs');
  const lensTitles = vscode.providers.codeLens.provideCodeLenses(td).map((l) => l.command.title);
  assert.ok(lensTitles.some((t) => t.includes('Accept incoming')) && lensTitles.some((t) => t.includes('Accept current')) && lensTitles.some((t) => t.includes('Accept both')), lensTitles.join(' | '));
  const confHover = vscode.providers.hover.provideHover(td, new vscode.Position(15, 0));
  assert.ok(confHover.contents.value.includes('Conflict') && confHover.contents.value.includes('+ line 15 theirs'));

  // keyboard review with auto-advance: accept mine@8 -> cursor on 10; reject mine@10 -> cursor on 15 (conflict)
  te.selection = new vscode.Selection(8, 0, 8, 0);
  await vscode.commands.executeCommand('gitInlineDiff.acceptHunk');
  assert.strictEqual(te.selection.active.line, 10, 'should advance to the next hunk after Accept');
  await vscode.commands.executeCommand('gitInlineDiff.rejectHunk');
  assert.strictEqual(td.lineAt(10).text, 'const timeout = 5000;');
  assert.strictEqual(te.selection.active.line, 15, 'should advance to the next hunk after Reject');
  await vscode.commands.executeCommand('gitInlineDiff.rejectHunk'); // conflict -> take theirs
  assert.strictEqual(td.lineAt(15).text, 'line 15 theirs');
  assert.strictEqual(te.selection.active.line, 20);
  te.selection = new vscode.Selection(3, 0, 3, 0);
  await vscode.commands.executeCommand('gitInlineDiff.rejectHunk'); // incoming -> take theirs
  assert.strictEqual(td.lineAt(3).text, 'line 3 theirs');
  assert.strictEqual(te.selection.active.line, 20, 'next pending hunk after line 3 is the deletion at 20');

  // take every remaining hunk from the remote -> identical to the remote branch
  await vscode.commands.executeCommand('gitInlineDiff.resetAccepted');
  await vscode.commands.executeCommand('gitInlineDiff.rejectAll');
  assert.strictEqual(td.getText(), remoteText, 'taking every hunk from the remote must reproduce the remote file');
  assert.strictEqual(controller.pending(controller.getState(td.uri)).length, 0);
  assert.ok(vscode.messages.some((m) => m.includes('2 mine, 1 incoming')), vscode.messages.join('\n'));

  // the remote already merged into HEAD -> plain two-way again
  git(tmp, 'merge', '-q', 'remote');
  controller.states.clear();
  controller.baseCache.clear();
  controller.blobCache.clear();
  const { doc: td2 } = openDoc(tFile, Wl.join('\n') + '\n', vscode.EndOfLine.LF);
  const ts2 = await controller.refresh(td2);
  assert.strictEqual(ts2.threeWay, false, 'no merge base when the remote is an ancestor of HEAD');
  assert.ok(ts2.hunks.every((h) => h.kind === 'mine'));

  // ---- rows mode (editorInsets): one row block per hunk with the buttons inside, no CodeLens, keep-both for conflicts
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.writeFileSync(tFile, B.join('\n') + '\n'); // fresh merge base (main currently holds the merged "remote" content)
  git(tmp, 'commit', '-q', '-am', 't base 2');
  git(tmp, 'checkout', '-q', '-b', 'rows-remote');
  const R2 = B.slice();
  R2[3] = 'line 3 theirs';
  R2[15] = 'line 15 theirs';
  fs.writeFileSync(tFile, R2.join('\n') + '\n');
  git(tmp, 'commit', '-q', '-am', 'theirs 2');
  git(tmp, 'checkout', '-q', '-');
  vscode.config.base = 'rows-remote';
  vscode.config.removedLinesView = 'rows';
  vscode.insets.length = 0;
  controller.states.clear();
  controller.baseCache.clear();
  controller.blobCache.clear();
  const W2 = B.slice();
  W2[8] = 'line 8 mine';
  W2[15] = 'line 15 mine';
  W2.splice(20, 1);
  W2.push('tail mine'); // insert-only hunk at the very end
  const { doc: rd, editor: re } = openDoc(tFile, W2.join('\n') + '\n', vscode.EndOfLine.LF);
  let rs = await controller.refresh(rd);
  assert.strictEqual(rs.kind, 'ok', rs.error);
  assert.ok(controller.rowsActive(), 'rows mode must be active with the fake inset API');
  assert.deepStrictEqual(vscode.providers.codeLens.provideCodeLenses(rd), [], 'no CodeLens in rows mode');
  assert.strictEqual((re.decorations.get(controller.decor.mine.text.key) || []).length, 0, 'no chips in rows mode');
  await sleep(120);
  const live = () => vscode.insets.filter((i) => !i.disposed);
  const kindsAt = live().map((i) => `${i.line}:${i.height}`).sort();
  // per hunk: a rows block ABOVE it (after the previous line) and a 2-row action bar (chip row + buttons row) BELOW it
  // incoming@3 -> rows after 2, bar after 3; mine@8 -> 7 / 8; conflict@15 -> 14 / 15;
  // deletion of line 20 (no lines of mine) -> rows and bar both after 19; insert-only tail -> bar only, after 29
  // bars are 2 rows (chip, buttons); the conflict rows block adds an "incoming" and a "current" header
  assert.deepStrictEqual(kindsAt, ['14:3', '15:2', '19:1', '19:2', '29:2', '2:1', '3:2', '7:1', '8:2'], JSON.stringify(kindsAt));
  const rowsAt = (line) => live().find((i) => i.line === line && !i.options.enableScripts);
  const barAt = (line) => live().find((i) => i.line === line && i.options.enableScripts);
  assert.ok(rowsAt(7).webview.html.includes('>line 8<') && !rowsAt(7).webview.html.includes('data-a='), 'rows show the old line only');
  assert.ok(rowsAt(14).webview.html.includes('incoming from rows-remote') && rowsAt(14).webview.html.includes('current · yours') && rowsAt(14).webview.html.includes('>line 15 theirs<'), 'conflict rows name both sides');
  assert.ok(barAt(8).webview.html.includes('data-a="reject"') && barAt(8).webview.html.includes('data-a="accept"'), 'bar below the hunk holds the buttons');
  assert.ok(barAt(8).webview.html.includes('yours · not on rows-remote'));
  assert.ok(barAt(15).webview.html.includes('data-a="both"'), 'conflict bar offers keep both');
  assert.ok(barAt(3).webview.html.includes('incoming from rows-remote'), 'incoming bar says where it comes from');
  assert.ok(barAt(29).webview.html.includes('1 new line not on rows-remote'), 'insert-only hunk gets a bar only');
  assert.ok(!barAt(29).webview.html.includes('data-a="both"'));
  const deletion = live().filter((i) => i.line === 19);
  assert.ok(deletion[0].options.enableScripts === false && deletion[1].options.enableScripts === true, 'rows are created before the bar when both sit after the same line');

  // jump buttons + counter inside the bar
  assert.ok(barAt(8).webview.html.includes('data-a="next"') && barAt(8).webview.html.includes('data-a="prev"') && barAt(8).webview.html.includes('>2 / 5<'), 'bar shows the position and the jump buttons');
  barAt(8).click('next');
  await sleep(60);
  assert.strictEqual(re.selection.active.line, 15, 'next from the bar jumps to the following hunk');
  barAt(8).click('prev');
  await sleep(60);
  assert.strictEqual(re.selection.active.line, 3, 'prev from the bar jumps to the previous hunk');
  barAt(3).click('prev');
  await sleep(60);
  assert.strictEqual(re.selection.active.line, 29, 'prev wraps around to the last hunk');

  // click Accept in the bar -> hunk accepted, both of its insets disposed, counters of the others pushed
  barAt(8).click('accept');
  await sleep(150);
  rs = controller.getState(rd.uri);
  assert.strictEqual(controller.pending(rs).length, 4);
  assert.ok(!rowsAt(7) && !barAt(8), 'accepted hunk has no blocks any more');
  const posted = barAt(15)._posted.filter((m) => m.type === 'pos');
  assert.deepStrictEqual(posted[posted.length - 1], { type: 'pos', index: 2, total: 4 }, 'live bars get the new position without a rebuild');

  // keep both on the conflict: theirs above mine, region marked reviewed
  barAt(15).click('both');
  await sleep(150);
  assert.strictEqual(rd.lineAt(15).text, 'line 15 theirs');
  assert.strictEqual(rd.lineAt(16).text, 'line 15 mine');
  rs = controller.getState(rd.uri);
  assert.strictEqual(controller.pending(rs).length, 3, 'merged region is accepted');
  assert.ok(!controller.pending(rs).some((h) => h.kind === 'conflict'));

  // take theirs on the incoming hunk through the bar button
  barAt(3).click('reject');
  await sleep(150);
  assert.strictEqual(rd.lineAt(3).text, 'line 3 theirs');
  await sleep(120);
  assert.deepStrictEqual(live().map((i) => i.line).sort((a, b) => a - b), [20, 20, 30], 'remaining blocks: the deletion (rows + bar) and the tail bar, shifted by the kept line');

  // switching the setting back to chips removes every row
  vscode.config.removedLinesView = 'inline';
  controller.resetAll();
  await controller.refresh(rd, true);
  await sleep(120);
  assert.strictEqual(live().length, 0, 'rows disposed when the setting is off');
  assert.ok(vscode.providers.codeLens.provideCodeLenses(rd).length > 0, 'CodeLens is back in inline mode');

  // proposal not enabled: the first create throws -> rows give up, chips + a one-time prompt
  vscode.config.removedLinesView = 'rows';
  const realCreate = vscode.window.createWebviewTextEditorInset;
  vscode.window.createWebviewTextEditorInset = () => {
    throw new Error("Extension 'Ghammes.hunkly' CANNOT use API proposal: editorInsets.");
  };
  controller.resetAll();
  await controller.refresh(rd, true);
  await sleep(120);
  assert.strictEqual(controller.insets.available, false);
  assert.ok((re.decorations.get(controller.decor.mine.text.key) || []).length > 0, 'chips drawn after the fallback');
  assert.ok(vscode.messages.some((m) => m.includes('editorInsets')), 'user told how to enable rows');
  vscode.window.createWebviewTextEditorInset = realCreate;
  vscode.config.removedLinesView = 'inline';
  controller.resetAll();

  console.log('smoke test: all assertions passed');

  // ---- optional: a real file, with the user's configuration (upstream by default)
  const real = process.argv[2];
  if (real) {
    delete vscode.config.base;
    const text = fs.readFileSync(real, 'utf8');
    const { doc: rd } = openDoc(path.resolve(real), text, text.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF);
    const rs = await controller.refresh(rd);
    console.log(`real file: kind=${rs.kind} base=${rs.label} hunks=${rs.hunks.length}${rs.error ? ' error=' + rs.error : ''}`);
    // simulate an edit: change line 3 and drop line 6
    const lines = text.split(/\r\n|\r|\n/);
    lines[3] = (lines[3] || '') + ' // edited';
    lines.splice(6, 1);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const { doc: rd2 } = openDoc(path.resolve(real), lines.join(eol), eol === '\r\n' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF);
    const rs2 = await controller.refresh(rd2);
    console.log(`after a simulated edit: hunks=${rs2.hunks.length}`);
    for (const h of rs2.hunks) console.log('  ', JSON.stringify({ newStart: h.newStart, old: h.oldLines, new: h.newLines }).slice(0, 200));
  }

  if (vscode.messages.length) console.log('messages:', vscode.messages);
  controller.dispose();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      break;
    } catch (err) {
      // Windows: git / timers may still hold the directory for a moment
      if (i === 4) console.log('could not remove the temp repo (ignored):', tmp);
      else await new Promise((r) => setTimeout(r, 300));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
