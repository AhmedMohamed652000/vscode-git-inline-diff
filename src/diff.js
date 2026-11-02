'use strict';
// Line diff between the base version(s) and the current document. No dependency on the vscode module.

const { diffArrays } = require('diff');
const crypto = require('crypto');

/**
 * @typedef {object} Hunk
 * @property {string} id            stable id: hash of kind + old + new content (+ occurrence index)
 * @property {'mine'|'incoming'|'conflict'} kind
 *   mine     — only my side differs from the merge base; Reject restores the base (== remote) lines
 *   incoming — only the remote differs from the merge base; the document still has the base lines; Reject takes theirs
 *   conflict — both sides changed the same region; Reject takes theirs, Accept keeps mine
 * @property {number} oldStart      0-based line in the base where the hunk starts
 * @property {string[]} oldLines    what Reject writes: the remote version of the region
 * @property {string[]} baseLines   merge-base version of the region (same as oldLines for `mine`)
 * @property {number} newStart      0-based line in the current document where the hunk starts
 * @property {number} newCount      number of current-document lines in the hunk (0 = pure deletion)
 * @property {string[]} newLines    current-document lines of the region
 */

function splitLines(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split(/\r\n|\r|\n/);
}

function sameLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Raw line diff: consecutive removed/added parts grouped into hunks.
 * @returns {Array<{aStart: number, aLines: string[], bStart: number, bLines: string[]}>}
 */
function rawDiff(aLines, bLines, opts = {}) {
  const options = opts.ignoreWhitespace ? { comparator: (a, b) => a.trim() === b.trim() } : undefined;
  const parts = diffArrays(aLines, bLines, options);
  const hunks = [];
  let aPos = 0;
  let bPos = 0;
  let cur = null;
  for (const part of parts) {
    const n = part.value.length;
    if (part.added || part.removed) {
      if (!cur) cur = { aStart: aPos, bStart: bPos, aLines: [], bLines: [] };
      if (part.removed) {
        for (const l of part.value) cur.aLines.push(l);
        aPos += n;
      } else {
        for (const l of part.value) cur.bLines.push(l);
        bPos += n;
      }
    } else {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      aPos += n;
      bPos += n;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

function finalize(hunks) {
  hunks.sort((a, b) => a.newStart - b.newStart);
  const seen = new Map();
  for (const h of hunks) {
    h.newCount = h.newLines.length;
    const base = crypto
      .createHash('sha1')
      .update(h.kind + '\u0000' + h.oldLines.join('\n') + '\u0000' + h.newLines.join('\n'))
      .digest('hex')
      .slice(0, 16);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}#${n}` : base;
  }
  return hunks;
}

/**
 * Two-way diff: every difference is "mine".
 * @param {string[]} oldLines base / remote
 * @param {string[]} newLines current document
 * @returns {Hunk[]}
 */
function computeHunks(oldLines, newLines, opts = {}) {
  const hunks = rawDiff(oldLines, newLines, opts).map((h) => ({
    id: '',
    kind: 'mine',
    oldStart: h.aStart,
    oldLines: h.aLines,
    baseLines: h.aLines,
    newStart: h.bStart,
    newCount: 0,
    newLines: h.bLines,
  }));
  return finalize(hunks);
}

/**
 * Three-way classification against the merge base.
 * @param {string[]} B merge base (last commit both sides share)
 * @param {string[]} R remote tip
 * @param {string[]} W current document
 * @returns {Hunk[]}
 */
function computeThreeWay(B, R, W, opts = {}) {
  const M = rawDiff(B, W, opts); // my changes, in B coordinates
  const T = rawDiff(B, R, opts); // their changes, in B coordinates
  const aEnd = (h) => h.aStart + h.aLines.length;
  const delta = (h) => h.bLines.length - h.aLines.length;
  // touching regions count as overlapping, like git's merge does
  const overlap = (x, y) => x.aStart <= aEnd(y) && y.aStart <= aEnd(x);

  const n = M.length + T.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    parent[find(i)] = find(j);
  };
  for (let i = 0; i < M.length; i++) for (let j = 0; j < T.length; j++) if (overlap(M[i], T[j])) union(i, M.length + j);

  /** @type {Map<number, {m: typeof M, t: typeof T}>} */
  const groups = new Map();
  const groupOf = (idx) => {
    const r = find(idx);
    if (!groups.has(r)) groups.set(r, { m: [], t: [] });
    return groups.get(r);
  };
  M.forEach((h, i) => groupOf(i).m.push(h));
  T.forEach((h, j) => groupOf(M.length + j).t.push(h));

  /** @type {Hunk[]} */
  const hunks = [];
  for (const g of groups.values()) {
    if (g.t.length === 0) {
      for (const m of g.m) {
        hunks.push({ id: '', kind: 'mine', oldStart: m.aStart, oldLines: m.aLines, baseLines: m.aLines, newStart: m.bStart, newCount: 0, newLines: m.bLines });
      }
      continue;
    }
    const inGroupM = new Set(g.m);
    const inGroupT = new Set(g.t);
    const all = [...g.m, ...g.t];
    const u0 = Math.min(...all.map((h) => h.aStart));
    const u1 = Math.max(...all.map(aEnd));
    // map the base region [u0, u1) into document (W) and remote (R) coordinates
    let wBefore = 0;
    let wInside = 0;
    for (const m of M) {
      if (inGroupM.has(m)) wInside += delta(m);
      else if (aEnd(m) <= u0) wBefore += delta(m);
    }
    let rBefore = 0;
    let rInside = 0;
    for (const t of T) {
      if (inGroupT.has(t)) rInside += delta(t);
      else if (aEnd(t) <= u0) rBefore += delta(t);
    }
    const w0 = u0 + wBefore;
    const w1 = u1 + wBefore + wInside;
    const r0 = u0 + rBefore;
    const r1 = u1 + rBefore + rInside;
    const mine = W.slice(w0, w1);
    const theirs = R.slice(r0, r1);
    if (sameLines(mine, theirs)) continue; // both sides made the same change
    hunks.push({
      id: '',
      kind: g.m.length === 0 ? 'incoming' : 'conflict',
      oldStart: u0,
      oldLines: theirs,
      baseLines: B.slice(u0, u1),
      newStart: w0,
      newCount: 0,
      newLines: mine,
    });
  }
  return finalize(hunks);
}

/** Document line that carries the marker of a pure deletion (the line right after the removed block). */
function markerLine(h, lineCount) {
  return Math.max(0, Math.min(h.newStart, lineCount - 1));
}

function firstLine(h, lineCount) {
  return h.newCount > 0 ? Math.min(h.newStart, lineCount - 1) : markerLine(h, lineCount);
}

function lastLine(h, lineCount) {
  return h.newCount > 0 ? Math.min(h.newStart + h.newCount - 1, lineCount - 1) : markerLine(h, lineCount);
}

function hunkContains(h, line, lineCount) {
  if (h.newCount > 0) return line >= h.newStart && line < h.newStart + h.newCount;
  return line === markerLine(h, lineCount);
}

module.exports = { splitLines, computeHunks, computeThreeWay, markerLine, firstLine, lastLine, hunkContains };
