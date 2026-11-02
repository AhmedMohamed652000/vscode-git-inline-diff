'use strict';

const vscode = require('vscode');

function bar(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="5" y="0" width="3" height="16" rx="1" fill="${color}"/></svg>`;
  return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

const tc = (id) => new vscode.ThemeColor(id);

/** Per-kind palette. `line` = whole-line background, `marker` = border/overview colour, `text*` = the inline chip. */
const KINDS = {
  mine: {
    gutter: '#3fb950',
    gutterRemoved: '#f85149',
    line: 'gitInlineDiff.addedLineBackground',
    lineOverview: 'diffEditorOverview.insertedForeground',
    marker: 'gitInlineDiff.removedMarker',
    markerOverview: 'diffEditorOverview.removedForeground',
    textFg: 'gitInlineDiff.removedTextForeground',
    textBg: 'gitInlineDiff.removedTextBackground',
  },
  incoming: {
    gutter: '#58a6ff',
    gutterRemoved: '#58a6ff',
    line: 'gitInlineDiff.incomingLineBackground',
    lineOverview: 'gitInlineDiff.incomingMarker',
    marker: 'gitInlineDiff.incomingMarker',
    markerOverview: 'gitInlineDiff.incomingMarker',
    textFg: 'gitInlineDiff.incomingTextForeground',
    textBg: 'gitInlineDiff.incomingTextBackground',
  },
  conflict: {
    gutter: '#d29922',
    gutterRemoved: '#d29922',
    line: 'gitInlineDiff.conflictLineBackground',
    lineOverview: 'gitInlineDiff.conflictMarker',
    marker: 'gitInlineDiff.conflictMarker',
    markerOverview: 'gitInlineDiff.conflictMarker',
    textFg: 'gitInlineDiff.conflictTextForeground',
    textBg: 'gitInlineDiff.conflictTextBackground',
  },
};

/**
 * @param {{gutter: boolean}} options
 * @returns {{mine: KindDecorations, incoming: KindDecorations, conflict: KindDecorations, hint: vscode.TextEditorDecorationType, all: vscode.TextEditorDecorationType[]}}
 * @typedef {{line: vscode.TextEditorDecorationType, top: vscode.TextEditorDecorationType, bottom: vscode.TextEditorDecorationType, text: vscode.TextEditorDecorationType}} KindDecorations
 */
function createDecorationTypes(options) {
  const gutter = (color) => (options.gutter ? { gutterIconPath: bar(color), gutterIconSize: 'contain' } : {});
  const all = [];
  const make = (opts) => {
    const t = vscode.window.createTextEditorDecorationType(opts);
    all.push(t);
    return t;
  };

  const result = { all };
  for (const [kind, p] of Object.entries(KINDS)) {
    result[kind] = {
      // document lines that belong to the hunk
      line: make({
        isWholeLine: true,
        backgroundColor: tc(p.line),
        overviewRulerColor: tc(p.lineOverview),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        ...gutter(p.gutter),
      }),
      // the line right after a block that exists only on the other side (pure deletion / incoming insertion)
      top: make({
        isWholeLine: true,
        borderWidth: '2px 0 0 0',
        borderStyle: 'solid',
        borderColor: tc(p.marker),
        overviewRulerColor: tc(p.markerOverview),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        ...gutter(p.gutterRemoved),
      }),
      // same, when that block sits at the very end of the file
      bottom: make({
        isWholeLine: true,
        borderWidth: '0 0 2px 0',
        borderStyle: 'solid',
        borderColor: tc(p.marker),
        overviewRulerColor: tc(p.markerOverview),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        ...gutter(p.gutterRemoved),
      }),
      // the other side's text, rendered after the line
      text: make({
        after: {
          margin: '0 0 0 2em',
          color: tc(p.textFg),
          backgroundColor: tc(p.textBg),
          textDecoration: 'none; padding: 0 6px; border-radius: 3px; white-space: pre;',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
    };
  }

  // "Reject Ctrl+N · Accept Ctrl+Shift+Y" on the last line of the hunk under the cursor
  result.hint = make({
    after: {
      margin: '0 0 0 3em',
      color: tc('gitInlineDiff.hintForeground'),
      fontStyle: 'italic',
      textDecoration: 'none; font-size: 0.85em;',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  return result;
}

module.exports = { createDecorationTypes };
