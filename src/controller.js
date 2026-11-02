'use strict';

const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { computeHunks, computeThreeWay, splitLines, markerLine, firstLine, lastLine, hunkContains } = require('./diff');
const { createDecorationTypes } = require('./decorations');
const { InsetRenderer } = require('./insets');

const SECTION = 'gitInlineDiff';
const ACCEPTED_KEY = 'gitInlineDiff.accepted';
const BLOB_TTL = 10 * 1000; // re-check the base blob sha at most every 10 s per file
const BASE_TTL = 5 * 1000; // re-resolve the upstream ref / merge base at most every 5 s per repo

const KINDS = ['mine', 'incoming', 'conflict'];
const KIND_PREFIX = { mine: '−', incoming: '+', conflict: '⇄' };
const KIND_HINT = {
  mine: 'Reject Ctrl+N  ·  Accept Ctrl+Shift+Y',
  incoming: 'Accept incoming Ctrl+N  ·  Dismiss Ctrl+Shift+Y',
  conflict: 'Accept incoming Ctrl+N  ·  Accept current Ctrl+Shift+Y',
};

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

function fmtRemoved(line) {
  const t = line.replace(/\t/g, '    ').trim();
  return t === '' ? '␣' : t;
}

/** "3 mine, 2 incoming, 1 conflict" */
function describeHunks(hunks) {
  const counts = { mine: 0, incoming: 0, conflict: 0 };
  for (const h of hunks) counts[h.kind] = (counts[h.kind] || 0) + 1;
  const parts = [];
  if (counts.mine) parts.push(`${counts.mine} mine`);
  if (counts.incoming) parts.push(`${counts.incoming} incoming`);
  if (counts.conflict) parts.push(`${counts.conflict} conflict${counts.conflict > 1 ? 's' : ''}`);
  return { counts, text: parts.join(', ') };
}

/**
 * @typedef {object} DocState
 * @property {string} key
 * @property {vscode.Uri} uri
 * @property {'pending'|'ineligible'|'notgit'|'error'|'new'|'ok'} kind
 * @property {string|null|undefined} root
 * @property {string} [ref]
 * @property {string} [label]
 * @property {string} [rel]
 * @property {string|null} [sha]
 * @property {string[]|null} [baseLines]     remote / base version (what Reject restores)
 * @property {boolean} [threeWay]            true when a merge base was used to classify hunks
 * @property {string|null} [mergeBase]
 * @property {import('./diff').Hunk[]} hunks
 * @property {Set<string>} accepted
 * @property {number} version
 * @property {number} gen
 * @property {string} [error]
 */

class Controller {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {Map<string, DocState>} */
    this.states = new Map();
    /** @type {Map<string, {sha: string|null, lines: string[]|null, at: number}>} */
    this.blobCache = new Map();
    /** @type {Map<string, {at: number, value: {ref: string, label: string, exists: boolean, refSha: string|null, mergeBase: string|null}}>} */
    this.baseCache = new Map();
    this.timers = new Map();
    this.disposables = [];
    this._onDidChange = new vscode.EventEmitter();
    /** Fires with the document uri whenever hunks or accepted state changed. */
    this.onDidChange = this._onDidChange.event;
    this.output = vscode.window.createOutputChannel('Hunkly');
    this.decor = createDecorationTypes({ gutter: cfg().get('showGutterIcons', true) });
    this.insets = new InsetRenderer({
      log: (m) => this.log(m),
      onUnavailable: (err) => this.reportInsetsUnavailable(err),
      onAction: (uri, hunkId, action) => this.insetAction(uri, hunkId, action),
    });
    this.status = vscode.window.createStatusBarItem('gitInlineDiff.status', vscode.StatusBarAlignment.Right, 100);
    this.status.name = 'Hunkly';
    this.status.command = 'gitInlineDiff.showMenu';
    // ↑ ↓ next to the summary: jump between changes with the mouse
    this.statusPrev = vscode.window.createStatusBarItem('gitInlineDiff.prev', vscode.StatusBarAlignment.Right, 99);
    this.statusPrev.name = 'Hunkly: previous change';
    this.statusPrev.text = '$(chevron-up)';
    this.statusPrev.tooltip = 'Previous change (Shift+F7)';
    this.statusPrev.command = 'gitInlineDiff.previousHunk';
    this.statusNext = vscode.window.createStatusBarItem('gitInlineDiff.next', vscode.StatusBarAlignment.Right, 98);
    this.statusNext.name = 'Hunkly: next change';
    this.statusNext.text = '$(chevron-down)';
    this.statusNext.tooltip = 'Next change (F7)';
    this.statusNext.command = 'gitInlineDiff.nextHunk';
    this.disposables.push(this.statusPrev, this.statusNext);
    this.accepted = context.workspaceState.get(ACCEPTED_KEY, {}) || {};
    this.gitMissingReported = false;
    this.repoChangeTimer = undefined;
    this.disposables.push(this._onDidChange, this.status, this.output);
    this.wire();
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.repoChangeTimer) clearTimeout(this.repoChangeTimer);
    this.insets.dispose();
    for (const d of this.decor.all) d.dispose();
    for (const d of this.disposables) d.dispose();
  }

  log(msg) {
    const text = msg instanceof Error ? `${msg.message}${msg.stderr ? '\n' + msg.stderr : ''}` : String(msg);
    this.output.appendLine(`[${new Date().toISOString()}] ${text}`);
  }

  /** The editorInsets proposal is not enabled for this extension: redraw with chips and say how to turn rows on. */
  reportInsetsUnavailable(err) {
    for (const ed of vscode.window.visibleTextEditors) {
      const st = this.getState(ed.document.uri);
      if (st) this.decorate(ed, st);
    }
    if (!/CANNOT use|proposed/i.test(String(err && err.message))) return;
    vscode.window
      .showInformationMessage(
        'Hunkly: showing removed lines as full rows needs the "editorInsets" proposed API. Enable it for this extension? (quit and start the editor again afterwards)',
        'Enable rows',
        'Use inline chips'
      )
      .then((pick) => {
        if (pick === 'Enable rows') vscode.commands.executeCommand('gitInlineDiff.enableInlineRows');
        else if (pick === 'Use inline chips') cfg().update('removedLinesView', 'inline', vscode.ConfigurationTarget.Global);
      });
  }

  // ---------------------------------------------------------------- wiring

  wire() {
    const d = this.disposables;
    d.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) this.scheduleRefresh(ed.document, 0);
        this.updateStatus(ed);
        this.updateContext();
      })
    );
    d.push(
      vscode.window.onDidChangeVisibleTextEditors((eds) => {
        for (const ed of eds) this.scheduleRefresh(ed.document, 0);
      })
    );
    d.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.isVisible(e.document)) this.scheduleRefresh(e.document, 300);
      })
    );
    d.push(vscode.workspace.onDidCloseTextDocument((doc) => this.drop(doc)));
    d.push(vscode.window.onDidChangeTextEditorSelection((e) => this.updateCursor(e.textEditor)));
    d.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) this.resetAll();
      })
    );
    this.hookGitExtension();
    this.refreshVisible();
  }

  hookGitExtension() {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return;
    Promise.resolve(ext.isActive ? ext.exports : ext.activate())
      .then((exports) => {
        const api = exports && exports.getAPI && exports.getAPI(1);
        if (!api) return;
        const hook = (repo) => this.disposables.push(repo.state.onDidChange(() => this.onRepoChanged()));
        api.repositories.forEach(hook);
        this.disposables.push(api.onDidOpenRepository(hook));
      })
      .catch((err) => this.log(err));
  }

  /** HEAD / refs / index moved (commit, fetch, pull, checkout, stage...). Re-resolve the base for visible files. */
  onRepoChanged() {
    if (this.repoChangeTimer) clearTimeout(this.repoChangeTimer);
    this.repoChangeTimer = setTimeout(() => {
      this.repoChangeTimer = undefined;
      this.baseCache.clear();
      this.refreshVisible(true);
    }, 1500);
  }

  isVisible(doc) {
    return vscode.window.visibleTextEditors.some((ed) => ed.document === doc);
  }

  refreshVisible(force = false) {
    for (const ed of vscode.window.visibleTextEditors) {
      this.refresh(ed.document, force).catch((err) => this.log(err));
    }
  }

  resetAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.states.clear();
    this.blobCache.clear();
    this.baseCache.clear();
    git.clearRootCache();
    this.insets.disposeAll();
    for (const d of this.decor.all) d.dispose();
    this.decor = createDecorationTypes({ gutter: cfg().get('showGutterIcons', true) });
    this.updateStatus(vscode.window.activeTextEditor);
    this.updateContext();
    this.refreshVisible(true);
  }

  drop(doc) {
    const key = doc.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.states.delete(key);
  }

  scheduleRefresh(doc, delay) {
    const key = doc.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc).catch((err) => this.log(err));
      }, delay)
    );
  }

  // ---------------------------------------------------------------- state

  /** @returns {DocState|undefined} */
  getState(uri) {
    return this.states.get(uri.toString());
  }

  /** Hunks that were not accepted / dismissed yet. */
  pending(st) {
    return st.hunks.filter((h) => !st.accepted.has(h.id));
  }

  /** Pending hunk under `line`, if the state is current for the document. */
  hunkAt(doc, line) {
    const st = this.getState(doc.uri);
    if (!st || st.kind !== 'ok' || st.version !== doc.version) return undefined;
    return this.pending(st).find((h) => hunkContains(h, line, doc.lineCount));
  }

  isEligible(doc) {
    if (doc.uri.scheme !== 'file' || doc.isUntitled) return false;
    const c = cfg();
    if (!c.get('enabled', true)) return false;
    if (doc.lineCount > c.get('maxLines', 20000)) return false;
    if (/[\\/]\.git[\\/]/.test(doc.uri.fsPath)) return false;
    const exclude = c.get('exclude', []);
    for (const pattern of exclude) {
      if (pattern && vscode.languages.match({ pattern }, doc) > 0) return false;
    }
    return true;
  }

  /**
   * Recompute the hunks of `doc` against its base and redraw.
   * @param {vscode.TextDocument} doc
   * @param {boolean} [force] re-resolve the base ref and blobs even if cached
   */
  async refresh(doc, force = false) {
    const key = doc.uri.toString();
    let st = this.states.get(key);
    if (!st) {
      st = { key, uri: doc.uri, kind: 'pending', root: undefined, hunks: [], accepted: new Set(), version: -1, gen: 0 };
      this.states.set(key, st);
    }
    const gen = ++st.gen;

    if (!this.isEligible(doc)) {
      st.kind = 'ineligible';
      st.hunks = [];
      this.finish(st, doc);
      return st;
    }

    try {
      if (st.root === undefined || force) {
        st.root = await git.repoRoot(path.dirname(doc.uri.fsPath));
        if (gen !== st.gen) return st;
      }
      if (!st.root) {
        st.kind = 'notgit';
        st.hunks = [];
        this.finish(st, doc);
        return st;
      }

      const base = await this.resolveBase(st.root, force);
      if (gen !== st.gen) return st;
      st.ref = base.ref;
      st.label = base.label;
      st.rel = git.relPath(st.root, doc.uri.fsPath);
      if (!base.exists) {
        st.kind = 'error';
        st.error = `ref "${base.ref}" not found`;
        st.hunks = [];
        this.finish(st, doc);
        return st;
      }

      const remote = await this.getBlob(st, st.ref, force);
      if (gen !== st.gen) return st;
      st.sha = remote.sha;
      st.baseLines = remote.lines;
      if (!st.baseLines) {
        st.kind = 'new';
        st.hunks = [];
        st.version = doc.version;
        this.finish(st, doc);
        return st;
      }

      let mergeBaseLines = null;
      if (base.mergeBase) {
        const mb = await this.getBlob(st, base.mergeBase, force);
        if (gen !== st.gen) return st;
        mergeBaseLines = mb.lines; // null when the file did not exist at the merge base -> plain two-way
      }
      st.threeWay = !!mergeBaseLines;
      st.mergeBase = mergeBaseLines ? base.mergeBase : null;

      const version = doc.version;
      const opts = { ignoreWhitespace: cfg().get('ignoreWhitespace', false) };
      const current = splitLines(doc.getText());
      st.hunks = mergeBaseLines ? computeThreeWay(mergeBaseLines, st.baseLines, current, opts) : computeHunks(st.baseLines, current, opts);
      st.version = version;
      st.kind = 'ok';
      st.error = undefined;
      this.syncAccepted(st);
      this.finish(st, doc);
      return st;
    } catch (err) {
      if (git.isGitMissing(err)) {
        if (!this.gitMissingReported) {
          this.gitMissingReported = true;
          vscode.window.showWarningMessage('Hunkly: "git" was not found on PATH. The extension is idle until git is installed.');
        }
        st.kind = 'notgit';
      } else {
        st.kind = 'error';
        st.error = (err && err.message) || String(err);
        this.log(err);
      }
      st.hunks = [];
      this.finish(st, doc);
      return st;
    }
  }

  /**
   * Resolve the configured base for a repo: ref, label, its commit and the merge base with HEAD.
   * `mergeBase` is null when a two-way diff is enough (index / HEAD / ref already merged into HEAD / disabled).
   */
  async resolveBase(root, force) {
    const hit = this.baseCache.get(root);
    if (hit && !force && Date.now() - hit.at < BASE_TTL) return hit.value;
    const base = await git.resolveBase(root, cfg().get('base', 'upstream'));
    const refSha = base.ref ? await git.commitSha(root, base.ref) : '';
    const exists = base.ref ? !!refSha : true;
    let mergeBase = null;
    const twoWay = !base.ref || base.ref === 'HEAD' || !cfg().get('threeWay', true);
    if (exists && !twoWay) {
      const mb = await git.mergeBase(root, 'HEAD', base.ref);
      if (mb && mb !== refSha) mergeBase = mb; // the remote has commits HEAD does not contain
    }
    const value = { ...base, exists, refSha, mergeBase };
    this.baseCache.set(root, { at: Date.now(), value });
    return value;
  }

  /** Lines of the file at `ref`, cached by blob sha so a moved ref is picked up without re-reading unchanged files. */
  async getBlob(st, ref, force) {
    const ck = `${st.root}|${ref}|${st.rel}`;
    const hit = this.blobCache.get(ck);
    const now = Date.now();
    if (hit && !force && now - hit.at < BLOB_TTL) return hit;
    const sha = await git.blobSha(st.root, ref, st.rel);
    if (hit && hit.sha === sha) {
      hit.at = now;
      return hit;
    }
    const text = sha ? await git.catBlob(st.root, sha) : null;
    const entry = { sha, lines: text == null ? null : splitLines(text), at: now };
    this.blobCache.set(ck, entry);
    return entry;
  }

  /** Keep only accepted ids that still match a hunk; a hunk that changed must be reviewed again. */
  syncAccepted(st) {
    const ids = new Set(st.hunks.map((h) => h.id));
    const stored = this.accepted[st.key] || [];
    const kept = stored.filter((id) => ids.has(id));
    st.accepted = new Set(kept);
    if (kept.length !== stored.length) this.persistAccepted(st);
  }

  persistAccepted(st) {
    if (st.accepted.size) this.accepted[st.key] = [...st.accepted];
    else delete this.accepted[st.key];
    this.context.workspaceState.update(ACCEPTED_KEY, this.accepted);
  }

  finish(st, doc) {
    this.apply(st);
    this._onDidChange.fire(doc.uri);
    const active = vscode.window.activeTextEditor;
    if (active && active.document === doc) {
      this.updateStatus(active);
      this.updateContext();
    }
  }

  // ---------------------------------------------------------------- actions

  accept(doc, hunks) {
    const st = this.getState(doc.uri);
    if (!st) return;
    for (const h of hunks) st.accepted.add(h.id);
    this.persistAccepted(st);
    this.finish(st, doc);
  }

  resetAccepted(doc) {
    const st = this.getState(doc.uri);
    if (!st) return;
    st.accepted.clear();
    this.persistAccepted(st);
    this.finish(st, doc);
  }

  /** True when the other side's lines are drawn as rows (editorInsets available and the setting asks for it). */
  rowsActive() {
    return cfg().get('removedLinesView', 'rows') === 'rows' && this.insets.available;
  }

  /** A button inside a row block was clicked. */
  async insetAction(uri, hunkId, action) {
    if (action === 'next' || action === 'prev') return this.jump(uri, hunkId, action === 'next' ? 1 : -1);
    const command = { accept: 'gitInlineDiff.acceptHunk', reject: 'gitInlineDiff.rejectHunk', both: 'gitInlineDiff.keepBoth', diff: 'gitInlineDiff.openDiff' }[action];
    if (!command) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const editor = doc && vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
    await vscode.commands.executeCommand(command, uri.toString(), hunkId);
    // the click moved the focus into the webview; give it back to the editor so the shortcuts keep working
    if (editor && action !== 'diff') {
      const target = vscode.window.visibleTextEditors.find((ed) => ed.document === doc) || editor;
      await vscode.window.showTextDocument(doc, { viewColumn: target.viewColumn, preserveFocus: false, selection: target.selection });
    }
  }

  /**
   * Jump to the hunk before / after `hunkId` (wrapping around) and give the editor the focus back.
   * Works without an active editor, so it can be driven from a button inside a webview block.
   */
  async jump(uri, hunkId, dir) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const st = doc && this.getState(doc.uri);
    if (!doc || !st || st.kind !== 'ok') return;
    const hunks = this.pending(st)
      .slice()
      .sort((a, b) => firstLine(a, doc.lineCount) - firstLine(b, doc.lineCount));
    if (!hunks.length) return;
    const i = hunks.findIndex((h) => h.id === hunkId);
    const target = hunks[((i < 0 ? 0 : i + dir) + hunks.length) % hunks.length];
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
    const line = firstLine(target, doc.lineCount);
    const pos = new vscode.Position(line, 0);
    const shown = await vscode.window.showTextDocument(doc, { viewColumn: editor ? editor.viewColumn : undefined, preserveFocus: false, selection: new vscode.Range(pos, pos) });
    if (shown) shown.revealRange(new vscode.Range(line, 0, lastLine(target, doc.lineCount), 0), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * Conflict resolution "keep both": insert the remote lines above mine, then mark the merged region as reviewed.
   * Undoable like any edit.
   */
  async keepBoth(doc, hunk) {
    if (!hunk.oldLines.length) return this.accept(doc, [hunk]); // nothing to add: same as keeping mine
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const lineCount = doc.lineCount;
    const edit = new vscode.WorkspaceEdit();
    if (hunk.newStart >= lineCount) {
      edit.insert(doc.uri, doc.lineAt(lineCount - 1).range.end, eol + hunk.oldLines.join(eol));
    } else {
      edit.insert(doc.uri, new vscode.Position(hunk.newStart, 0), hunk.oldLines.map((l) => l + eol).join(''));
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error('VS Code refused the edit');
    const st = await this.refresh(doc);
    const merged = st.kind === 'ok' ? this.pending(st).find((h) => h.newStart === hunk.newStart) : undefined;
    if (merged) this.accept(doc, [merged]);
  }

  /**
   * Replace the hunk's lines in the document with `oldLines` (the base / remote version). Undoable.
   * All hunks must come from a state computed for the current document version.
   */
  async reject(doc, hunks) {
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const lineCount = doc.lineCount;
    const edit = new vscode.WorkspaceEdit();
    for (const h of hunks) {
      const { newStart, newCount, oldLines } = h;
      const endLine = newStart + newCount;
      if (newCount === 0) {
        if (newStart >= lineCount) {
          // the other side's block sits after the last line and the document has no trailing newline
          edit.insert(doc.uri, doc.lineAt(lineCount - 1).range.end, eol + oldLines.join(eol));
        } else {
          edit.insert(doc.uri, new vscode.Position(newStart, 0), oldLines.map((l) => l + eol).join(''));
        }
      } else if (endLine < lineCount) {
        edit.replace(doc.uri, new vscode.Range(newStart, 0, endLine, 0), oldLines.map((l) => l + eol).join(''));
      } else {
        // the hunk reaches the end of the document
        const docEnd = doc.lineAt(lineCount - 1).range.end;
        if (oldLines.length === 0) {
          const start = newStart === 0 ? new vscode.Position(0, 0) : doc.lineAt(newStart - 1).range.end;
          edit.delete(doc.uri, new vscode.Range(start, docEnd));
        } else {
          edit.replace(doc.uri, new vscode.Range(new vscode.Position(newStart, 0), docEnd), oldLines.join(eol));
        }
      }
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error('VS Code refused the edit');
    await this.refresh(doc);
  }

  // ---------------------------------------------------------------- rendering

  apply(st) {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() === st.key) this.decorate(ed, st);
    }
  }

  decorate(editor, st) {
    const doc = editor.document;
    const lineCount = doc.lineCount;
    const c = cfg();
    const rowsMode = this.rowsActive();
    const showText = c.get('removedLinesView', 'rows') !== 'off' && !rowsMode;
    const maxLen = Math.max(20, c.get('removedTextMaxLength', 200));
    const live = st.kind === 'ok' && st.version === doc.version;
    const rowHunks = [];

    const buckets = {};
    for (const kind of KINDS) buckets[kind] = { line: [], top: [], bottom: [], text: new Map() };
    const push = (b, line, text) => {
      const arr = b.text.get(line) || [];
      arr.push(text);
      b.text.set(line, arr);
    };

    if (live) {
      for (const h of this.pending(st)) {
        const b = buckets[h.kind] || buckets.mine;
        // the other side's lines as real rows above the hunk (Cursor style) when the insets API is usable
        const asRows = rowsMode;
        if (asRows) rowHunks.push(h);
        if (h.newCount > 0) {
          const end = Math.min(h.newStart + h.newCount - 1, lineCount - 1);
          b.line.push(new vscode.Range(h.newStart, 0, end, doc.lineAt(end).text.length));
          if (!asRows) {
            const pairs = Math.min(h.oldLines.length, h.newCount);
            for (let i = 0; i < pairs; i++) push(b, h.newStart + i, h.oldLines[i]);
            for (let i = pairs; i < h.oldLines.length; i++) push(b, end, h.oldLines[i]);
          }
        } else if (!asRows) {
          const line = markerLine(h, lineCount);
          const range = new vscode.Range(line, 0, line, doc.lineAt(line).text.length);
          (h.newStart >= lineCount ? b.bottom : b.top).push(range);
          for (const l of h.oldLines) push(b, line, l);
        }
      }
    }

    for (const kind of KINDS) {
      const b = buckets[kind];
      const d = this.decor[kind];
      editor.setDecorations(d.line, b.line);
      editor.setDecorations(d.top, b.top);
      editor.setDecorations(d.bottom, b.bottom);
      const textDecos = [];
      if (showText) {
        for (const [line, parts] of b.text) {
          let text = KIND_PREFIX[kind] + ' ' + parts.map(fmtRemoved).join(' ⏎ ');
          if (text.length > maxLen) text = text.slice(0, maxLen - 1) + '…';
          const len = doc.lineAt(line).text.length;
          textDecos.push({ range: new vscode.Range(line, len, line, len), renderOptions: { after: { contentText: text } } });
        }
      }
      editor.setDecorations(d.text, textDecos);
    }
    if (!rowsMode || st.kind !== 'ok') this.insets.clear(editor);
    else if (live) this.insets.sync(editor, rowHunks, { label: st.label || 'base', tabSize: Number(editor.options && editor.options.tabSize) || 4 });
    this.updateCursor(editor);
  }

  /** Keybinding hint on the hunk under the cursor + the `gitInlineDiff.hunkAtCursor` context key. */
  updateCursor(editor) {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const doc = editor.document;
    const hunk = this.hunkAt(doc, editor.selection.active.line);
    const hints = [];
    if (hunk && cfg().get('showKeybindingHint', true)) {
      const line = lastLine(hunk, doc.lineCount);
      const len = doc.lineAt(line).text.length;
      hints.push({
        range: new vscode.Range(line, len, line, len),
        renderOptions: { after: { contentText: KIND_HINT[hunk.kind] || KIND_HINT.mine } },
      });
    }
    editor.setDecorations(this.decor.hint, hints);
    if (editor === vscode.window.activeTextEditor) this.updateContext(!!hunk);
  }

  updateContext(hunkAtCursor) {
    const ed = vscode.window.activeTextEditor;
    const st = ed && this.getState(ed.document.uri);
    const hasHunks = !!(st && st.kind === 'ok' && this.pending(st).length > 0);
    if (hunkAtCursor === undefined) hunkAtCursor = !!(ed && this.hunkAt(ed.document, ed.selection.active.line));
    vscode.commands.executeCommand('setContext', 'gitInlineDiff.hasHunks', hasHunks);
    vscode.commands.executeCommand('setContext', 'gitInlineDiff.hunkAtCursor', hunkAtCursor);
  }

  updateStatus(editor) {
    const st = editor && this.getState(editor.document.uri);
    const nav = st && st.kind === 'ok' && this.pending(st).length > 0;
    if (nav) {
      this.statusPrev.show();
      this.statusNext.show();
    } else {
      this.statusPrev.hide();
      this.statusNext.hide();
    }
    if (!st || st.kind === 'pending' || st.kind === 'ineligible' || st.kind === 'notgit') {
      this.status.hide();
      return;
    }
    const label = st.label || 'base';
    if (st.kind === 'error') {
      this.status.text = `$(warning) Hunkly: ${st.error}`;
      this.status.tooltip = 'Hunkly — click for options';
    } else if (st.kind === 'new') {
      this.status.text = `$(diff-added) ${label}: new file`;
      this.status.tooltip = `This file does not exist in ${label}`;
    } else {
      const pending = this.pending(st);
      const a = st.accepted.size;
      const acceptedNote = a ? ` (${a} accepted)` : '';
      if (pending.length === 0) {
        this.status.text = `$(check) ${label}${acceptedNote}`;
        this.status.tooltip = a ? `No pending changes vs ${label}. ${a} hunk(s) accepted — click to show them again.` : `Same as ${label}`;
      } else {
        const { counts, text } = describeHunks(pending);
        const icon = counts.conflict ? '$(warning)' : counts.incoming ? '$(arrow-down)' : '$(git-compare)';
        const summary = st.threeWay ? text : `${pending.length} change${pending.length > 1 ? 's' : ''}`;
        this.status.text = `${icon} ${label}: ${summary}${acceptedNote}`;
        const notes = [`${pending.length} hunk(s) differ from ${label}`];
        if (counts.incoming) notes.push(`${counts.incoming} come from ${label} and are not in your HEAD yet — pull to merge them`);
        if (counts.conflict) notes.push(`${counts.conflict} region(s) were changed on both sides — a pull will conflict there`);
        this.status.tooltip = notes.join('\n') + '\nClick for options';
      }
    }
    this.status.show();
  }
}

module.exports = { Controller, cfg, SECTION, describeHunks };
