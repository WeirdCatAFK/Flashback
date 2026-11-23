#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const STR = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;

const RE_TP    = new RegExp(String.raw`(?<![.\w$])tp\s*\(\s*(${STR})\s*,\s*(${STR})`, 'g');
const RE_T     = new RegExp(String.raw`(?<![.\w$])t\s*\(\s*(${STR})`, 'g');
const RE_ANY   = new RegExp(String.raw`(?<![.\w$])(tp?)\s*\(\s*`, 'g');
const RE_QUOTE = /['"]/;

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

export function unquote(literal) {
  return literal.slice(1, -1).replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, esc) => {
      if (esc[0] === 'u') {
        const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
        return String.fromCodePoint(parseInt(hex, 16));
      }
      if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return ESCAPES[esc] ?? esc;
    },
  );
}

const isCommentLine = (line) => {
  const s = line.trimStart();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*');
};

function lineIndexer(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function extractFromSource(source, file = '<source>') {
  const lineAt = lineIndexer(source);
  const lines = source.split('\n');
  const skip = (offset) => isCommentLine(lines[lineAt(offset) - 1] ?? '');

  const hits = [];
  const violations = [];
  const resolved = { t: new Set(), tp: new Set() };

  for (const m of source.matchAll(RE_TP)) {
    if (skip(m.index)) continue;
    resolved.tp.add(m.index);
    hits.push({
      key: unquote(m[2]),
      one: unquote(m[1]),
      kind: 'plural',
      line: lineAt(m.index),
    });
  }

  for (const m of source.matchAll(RE_T)) {
    if (skip(m.index)) continue;
    resolved.t.add(m.index);
    hits.push({ key: unquote(m[1]), kind: 'plain', line: lineAt(m.index) });
  }

  for (const m of source.matchAll(RE_ANY)) {
    const fn = m[1];
    if (skip(m.index) || resolved[fn].has(m.index)) continue;
    const rest = source.slice(m.index + m[0].length);
    if (rest.startsWith(')')) continue;
    violations.push({
      file,
      line: lineAt(m.index),
      snippet: (lines[lineAt(m.index) - 1] ?? '').trim().slice(0, 100),
      reason: RE_QUOTE.test(rest[0] ?? '')
        ? `${fn}() needs a string literal in every message argument`
        : `${fn}() called with a non-literal key`,
    });
  }

  hits.sort((a, b) => a.line - b.line);
  return { hits, violations };
}

export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function extractTree(rootDir, { exclude = [] } = {}) {
  const keys = new Map();
  const violations = [];

  for (const file of walk(rootDir)) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    if (exclude.some((prefix) => rel.startsWith(prefix))) continue;

    const { hits, violations: bad } = extractFromSource(fs.readFileSync(file, 'utf8'), rel);
    violations.push(...bad);

    for (const hit of hits) {
      let entry = keys.get(hit.key);
      if (!entry) {
        entry = { kind: hit.kind, one: hit.one, uses: [] };
        keys.set(hit.key, entry);
      }
      if (hit.kind === 'plural') {
        entry.kind = 'plural';
        entry.one ??= hit.one;
      }
      entry.uses.push({ file: rel, line: hit.line });
    }
  }

  return { keys, violations };
}
