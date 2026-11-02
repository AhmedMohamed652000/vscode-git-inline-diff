'use strict';
// Turns the `editorInsets` proposed API on for this extension by listing it in the editor's argv.json
// ("enable-proposed-api"). No dependency on the vscode module so it can be run from plain node.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Remove line and block comments outside of strings (argv.json is JSON with comments). */
function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n === undefined ? '' : n;
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** argv.json of the editor installed at `appRoot` (<install>/resources/app), e.g. ~/.vscode/argv.json. */
function argvPathFor(appRoot) {
  if (process.env.HUNKLY_ARGV_JSON) return process.env.HUNKLY_ARGV_JSON; // tests and unusual setups
  let dataFolderName = '.vscode';
  try {
    const product = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8'));
    if (product.dataFolderName) dataFolderName = product.dataFolderName;
  } catch {
    /* fall back to .vscode */
  }
  return path.join(os.homedir(), dataFolderName, 'argv.json');
}

/**
 * Add `extensionId` to "enable-proposed-api" in argv.json, keeping the file's comments.
 * @returns {{argvPath: string, changed: boolean, list: string[]}}
 */
function enableProposedApi(argvPath, extensionId) {
  let text = '';
  try {
    text = fs.readFileSync(argvPath, 'utf8');
  } catch {
    text = '';
  }
  const parsed = text.trim() ? JSON.parse(stripJsonComments(text)) : {};
  const list = Array.isArray(parsed['enable-proposed-api']) ? parsed['enable-proposed-api'].slice() : [];
  if (list.includes(extensionId)) return { argvPath, changed: false, list };
  list.push(extensionId);

  let next;
  if (/"enable-proposed-api"\s*:\s*\[[^\]]*\]/.test(text)) {
    next = text.replace(/"enable-proposed-api"\s*:\s*\[[^\]]*\]/, `"enable-proposed-api": ${JSON.stringify(list)}`);
  } else if (text.trim()) {
    const closing = text.lastIndexOf('}');
    if (closing < 0) throw new Error(`${argvPath} does not look like a JSON object`);
    const before = text.slice(0, closing).replace(/\s+$/, '');
    const needsComma = !before.endsWith('{');
    next = `${before}${needsComma ? ',' : ''}\n\t"enable-proposed-api": ${JSON.stringify(list)}\n${text.slice(closing)}`;
  } else {
    next = `// This configuration file allows you to pass permanent command line arguments to the editor.\n{\n\t"enable-proposed-api": ${JSON.stringify(list)}\n}\n`;
  }
  // never write something the editor cannot parse
  const check = JSON.parse(stripJsonComments(next));
  if (!Array.isArray(check['enable-proposed-api']) || !check['enable-proposed-api'].includes(extensionId)) {
    throw new Error(`could not update ${argvPath}`);
  }
  if (text) fs.copyFileSync(argvPath, argvPath + '.bak');
  fs.mkdirSync(path.dirname(argvPath), { recursive: true });
  fs.writeFileSync(argvPath, next);
  return { argvPath, changed: true, list };
}

module.exports = { stripJsonComments, argvPathFor, enableProposedApi };
