'use strict';
// Thin wrapper around the git CLI. No dependency on the vscode module so it can be tested with plain node.

const { execFile } = require('child_process');
const path = require('path');

const MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.gitArgs = args;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function isGitMissing(err) {
  return !!err && err.code === 'ENOENT';
}

// directory -> { at, promise<string|null> }
const rootCache = new Map();
const NULL_ROOT_TTL = 60 * 1000;

/** Repository root (submodule root for files inside a submodule), or null when the directory is not inside a git work tree. */
function repoRoot(dir) {
  const hit = rootCache.get(dir);
  if (hit && (hit.root !== null || Date.now() - hit.at < NULL_ROOT_TTL)) return hit.promise;
  const entry = { at: Date.now(), root: undefined, promise: null };
  entry.promise = git(['rev-parse', '--show-toplevel'], dir)
    .then((out) => {
      entry.root = path.normalize(out.trim());
      return entry.root;
    })
    .catch((err) => {
      if (isGitMissing(err)) {
        rootCache.delete(dir);
        throw err;
      }
      entry.root = null;
      return null;
    });
  rootCache.set(dir, entry);
  return entry.promise;
}

function clearRootCache() {
  rootCache.clear();
}

/** Resolve the user setting into a git ref plus a label for the UI. */
async function resolveBase(root, setting) {
  const s = String(setting || 'upstream').trim();
  if (s.toLowerCase() === 'head') return { ref: 'HEAD', label: 'HEAD' };
  if (s.toLowerCase() === 'index') return { ref: '', label: 'index' };
  if (s.toLowerCase() === 'upstream') {
    try {
      const up = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)).trim();
      if (up) return { ref: up, label: up };
    } catch (err) {
      if (isGitMissing(err)) throw err;
    }
    return { ref: 'HEAD', label: 'HEAD (no upstream)' };
  }
  return { ref: s, label: s };
}

async function refExists(root, ref) {
  if (!ref) return true; // index
  try {
    await git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], root);
    return true;
  } catch (err) {
    if (isGitMissing(err)) throw err;
    return false;
  }
}

/** Commit sha of `ref`, or null when it does not resolve to a commit. */
async function commitSha(root, ref) {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], root)).trim() || null;
  } catch (err) {
    if (isGitMissing(err)) throw err;
    return null;
  }
}

/** Merge base of two refs, or null when they share no history. */
async function mergeBase(root, a, b) {
  try {
    return (await git(['merge-base', a, b], root)).trim() || null;
  } catch (err) {
    if (isGitMissing(err)) throw err;
    return null;
  }
}

/** Blob sha of `rel` at `ref` ('' = index), or null when the file does not exist there. */
async function blobSha(root, ref, rel) {
  try {
    const out = (await git(['rev-parse', '--verify', '--quiet', `${ref}:${rel}`], root)).trim();
    return out || null;
  } catch (err) {
    if (isGitMissing(err)) throw err;
    return null;
  }
}

async function catBlob(root, sha) {
  return git(['cat-file', 'blob', sha], root);
}

/** Path relative to the repo root, always with forward slashes. */
function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function fetch(root) {
  await git(['fetch', '--quiet'], root);
}

/**
 * Files that differ between `ref` and the working tree, plus untracked files.
 * @returns {Promise<Array<{status: string, path: string, oldPath?: string}>>}
 */
async function changedFiles(root, ref) {
  const out = await git(['diff', '--name-status', '-z', ref, '--'], root);
  const tokens = out.split('\0');
  const result = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (!status) break;
    if (status[0] === 'R' || status[0] === 'C') {
      result.push({ status: status[0], oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      result.push({ status: status[0], path: tokens[i + 1] });
      i += 2;
    }
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  for (const p of untracked.split('\0')) if (p) result.push({ status: '?', path: p });
  return result;
}

module.exports = { git, isGitMissing, repoRoot, clearRootCache, resolveBase, refExists, commitSha, mergeBase, blobSha, catBlob, relPath, fetch, changedFiles };
