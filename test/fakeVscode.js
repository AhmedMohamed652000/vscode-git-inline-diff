'use strict';
// Minimal stand-in for the `vscode` module so the extension can be exercised with plain node.

const pathMod = require('path');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isBefore(o) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
}

class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d);
    this.active = this.end;
    this.anchor = this.start;
  }
}

class Uri {
  constructor(scheme, p, query) {
    this.scheme = scheme;
    this.path = p;
    this.query = query || '';
    this.fsPath = scheme === 'file' ? pathMod.win32.normalize(p.replace(/^\/([a-zA-Z]:)/, '$1')) : p;
  }
  static file(p) {
    return new Uri('file', '/' + p.replace(/\\/g, '/'), '');
  }
  static from(o) {
    return new Uri(o.scheme, o.path, o.query);
  }
  static parse(s) {
    const m = /^([a-z-]+):(\/\/)?([^?]*)(?:\?(.*))?$/i.exec(s);
    return new Uri(m[1], decodeURIComponent(m[3]), m[4] ? decodeURIComponent(m[4]) : '');
  }
  toString() {
    return `${this.scheme}://${encodeURIComponent(this.path).replace(/%2F/g, '/')}${this.query ? '?' + encodeURIComponent(this.query) : ''}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (l) => {
      this.listeners.push(l);
      return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
    };
  }
  fire(x) {
    for (const l of this.listeners) l(x);
  }
  dispose() {}
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(v) {
    this.value = v || '';
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendCodeblock(c, l) {
    this.value += '\n```' + l + '\n' + c + '\n```\n';
    return this;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = contents;
    this.range = range;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  insert(uri, pos, text) {
    this.edits.push({ uri, range: new Range(pos, pos), text });
  }
  replace(uri, range, text) {
    this.edits.push({ uri, range, text });
  }
  delete(uri, range) {
    this.edits.push({ uri, range, text: '' });
  }
}

/** Fake TextDocument backed by a string. */
class TextDocument {
  constructor(fsPath, text, eol) {
    this.uri = Uri.file(fsPath);
    this.fileName = fsPath;
    this.isUntitled = false;
    this.languageId = 'javascript';
    this.version = 1;
    this.eol = eol;
    this.setText(text);
  }
  setText(text) {
    this.text = text;
    this.lines = text.split(/\r\n|\r|\n/);
  }
  get lineCount() {
    return this.lines.length;
  }
  getText() {
    return this.text;
  }
  lineAt(i) {
    const t = this.lines[i];
    if (t === undefined) throw new Error(`lineAt(${i}) out of range (lineCount ${this.lineCount})`);
    return { lineNumber: i, text: t, range: new Range(i, 0, i, t.length) };
  }
  offsetAt(pos) {
    const eolLen = this.eol === 2 ? 2 : 1;
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += this.lines[i].length + eolLen;
    return off + pos.character;
  }
  applyEdits(edits) {
    const sorted = edits.slice().sort((a, b) => this.offsetAt(b.range.start) - this.offsetAt(a.range.start));
    let text = this.text;
    for (const e of sorted) {
      const s = this.offsetAt(e.range.start);
      const t = this.offsetAt(e.range.end);
      text = text.slice(0, s) + e.text + text.slice(t);
    }
    this.setText(text);
    this.version++;
  }
}

class TextEditor {
  constructor(document) {
    this.document = document;
    this.selection = new Selection(0, 0, 0, 0);
    this.decorations = new Map();
  }
  setDecorations(type, ranges) {
    this.decorations.set(type.key, ranges);
  }
  revealRange() {}
}

function makeVscode() {
  const commands = new Map();
  const context = {};
  let decoKey = 0;
  const ev = () => new EventEmitter().event;
  const api = {
    Position,
    Range,
    Selection,
    Uri,
    EventEmitter,
    ThemeColor,
    MarkdownString,
    CodeLens,
    Hover,
    WorkspaceEdit,
    TextDocument,
    TextEditor,
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
    EndOfLine: { LF: 1, CRLF: 2 },
    ViewColumn: { Beside: -2 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    config: {},
    contextKeys: context,
    messages: [],
    insets: [],
    providers: {},
    window: {
      visibleTextEditors: [],
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: ev(),
      onDidChangeVisibleTextEditors: ev(),
      onDidChangeTextEditorSelection: ev(),
      createStatusBarItem: () => ({ text: '', tooltip: '', show() {}, hide() {}, dispose() {} }),
      createTextEditorDecorationType: (opts) => ({ key: 'deco' + decoKey++, opts, dispose() {} }),
      createOutputChannel: () => ({ appendLine: (l) => api.messages.push('[log] ' + l), dispose() {} }),
      // editorInsets proposal: records every inset so the test can inspect the html and click its buttons
      createWebviewTextEditorInset: (editor, line, height, options) => {
        if (!api.window.visibleTextEditors.includes(editor)) throw new Error('not a visible editor');
        const inset = {
          editor,
          line,
          height,
          options,
          disposed: false,
          _msg: [],
          _disp: [],
          _posted: [],
          webview: {
            html: '',
            onDidReceiveMessage: (l) => {
              inset._msg.push(l);
              return { dispose() {} };
            },
            postMessage: async (m) => {
              inset._posted.push(m);
              return true;
            },
          },
          onDidDispose: (l) => {
            inset._disp.push(l);
            return { dispose() {} };
          },
          dispose() {
            if (inset.disposed) return;
            inset.disposed = true;
            for (const l of inset._disp) l();
          },
          click(action) {
            for (const l of inset._msg) l({ action });
          },
        };
        api.insets.push(inset);
        return inset;
      },
      showInformationMessage: async (m) => void api.messages.push('[info] ' + m),
      // modal confirmations: answer with the first action item, as if the user confirmed
      showWarningMessage: async (m, ...rest) => {
        api.messages.push('[warn] ' + m);
        return rest.find((x) => typeof x === 'string');
      },
      showErrorMessage: async (m) => void api.messages.push('[error] ' + m),
      setStatusBarMessage: (m) => void api.messages.push('[status] ' + m),
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      // returns the visible editor of the document and applies the requested selection, like the real API
      showTextDocument: async (docOrUri, opts) => {
        const ed = api.window.visibleTextEditors.find((e) => e.document === docOrUri || e.document.uri.toString() === String(docOrUri));
        if (ed && opts && opts.selection) ed.selection = new Selection(opts.selection.start, opts.selection.end);
        if (ed) api.window.activeTextEditor = ed;
        return ed;
      },
      withProgress: (o, f) => f({ report() {} }),
    },
    workspace: {
      textDocuments: [],
      workspaceFolders: [],
      onDidChangeTextDocument: ev(),
      onDidCloseTextDocument: ev(),
      onDidChangeConfiguration: ev(),
      getConfiguration: () => ({
        get: (k, d) => (k in api.config ? api.config[k] : d),
        update: async (k, v) => void (api.config[k] = v),
      }),
      applyEdit: async (edit) => {
        for (const doc of api.workspace.textDocuments) {
          const mine = edit.edits.filter((e) => e.uri.toString() === doc.uri.toString());
          if (mine.length) doc.applyEdits(mine);
        }
        return true;
      },
      registerTextDocumentContentProvider: (scheme, p) => {
        api.providers.content = p;
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') {
          context[args[0]] = args[1];
          return;
        }
        const fn = commands.get(id);
        if (fn) return fn(...args);
        api.messages.push(`[exec] ${id} ${JSON.stringify(args.map((a) => (a && a.toString ? a.toString() : a))).slice(0, 200)}`);
      },
    },
    languages: {
      registerCodeLensProvider: (sel, p) => {
        api.providers.codeLens = p;
        return { dispose() {} };
      },
      registerHoverProvider: (sel, p) => {
        api.providers.hover = p;
        return { dispose() {} };
      },
      match: () => 0,
    },
    extensions: { getExtension: () => undefined },
  };
  return api;
}

module.exports = { makeVscode };
