#!/usr/bin/env node
/**
 * Translation key extraction.
 *
 * Scans the UI source for t() and tp() calls and returns every key with the file
 * and line it appears on. Because the English source text *is* the key, this scan
 * is the authoritative key list — there is no en.json to drift out of sync with it.
 *
 * Deliberately a scanner rather than a parser: the rule that makes that safe is
 * that t()/tp() must be called with string literals only. A call like t(label) is
 * reported as a violation instead of being silently skipped, so the constraint is
 * enforced rather than merely documented.
 *
 * Pure enough to test — extractFromSource() touches no filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A JS string literal, single or double quoted, honouring backslash escapes. */
const STR = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;

// (?<![.\w$]) keeps us off obj.t(...) and identifiers merely ending in t.
const RE_TP    = new RegExp(String.raw`(?<![.\w$])tp\s*\(\s*(${STR})\s*,\s*(${STR})`, 'g');
const RE_T     = new RegExp(String.raw`(?<![.\w$])t\s*\(\s*(${STR})`, 'g');
const RE_ANY   = new RegExp(String.raw`(?<![.\w$])(tp?)\s*\(\s*`, 'g');
const RE_QUOTE = /['"]/;

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** Turn a source literal into the string the app will actually see at runtime. */
export function unquote(literal) {
  return literal.slice(1, -1).replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, esc) => {
      if (esc[0] === 'u') {
        const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
        return String.fromCodePoint(parseInt(hex, 16));
      }
      if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return ESCAPES[esc] ?? esc; // covers \' \" \\ \` and anything else literal
    },
  );
}

/**
 * Comment lines are skipped so commented-out code doesn't inject phantom keys.
 * Only whole-line comments — stripping inline ones would corrupt any string
 * containing "//", and this codebase is full of flashback:// links.
 */
const isCommentLine = (line) => {
  const s = line.trimStart();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*');
};

/** Build a lookup from character offset → 1-indexed line number. */
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

/**
 * Extract from one file's text.
 * @returns {{ hits: Array, violations: Array }}
 *   hits:       { key, kind: 'plain'|'plural', one?, line }
 *   violations: { line, snippet } — a t()/tp() call not given a string literal
 */
export function extractFromSource(source, file = '<source>') {
  const lineAt = lineIndexer(source);
  const lines = source.split('\n');
  const skip = (offset) => isCommentLine(lines[lineAt(offset) - 1] ?? '');

  const hits = [];
  const violations = [];
  // Offsets where a call was fully resolved to literals, tracked per function so a
  // half-literal tp('one', n) can't hide behind its first argument.
  const resolved = { t: new Set(), tp: new Set() };

  for (const m of source.matchAll(RE_TP)) {
    if (skip(m.index)) continue;
    resolved.tp.add(m.index);
    hits.push({
      key: unquote(m[2]),          // the plural form is the key
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

  // Any call shaped like t()/tp() that the literal patterns above did NOT resolve
  // is a violation: t(label) or tp('one', plural, n) produce strings no pack can
  // contain. Checked per function name, since tp's failure mode still starts with
  // a valid-looking quote.
  for (const m of source.matchAll(RE_ANY)) {
    const fn = m[1];
    if (skip(m.index) || resolved[fn].has(m.index)) continue;
    const rest = source.slice(m.index + m[0].length);
    if (rest.startsWith(')')) continue; // bare t() — not a translation call
    violations.push({
      file,
      line: lineAt(m.index),
      snippet: (lines[lineAt(m.index) - 1] ?? '').trim().slice(0, 100),
      reason: RE_QUOTE.test(rest[0] ?? '')
        ? `${fn}() needs a string literal in every message argument`
        : `${fn}() called with a non-literal key`,
    });
  }

  // Emit in source order — the editor lists keys the way the file reads, which
  // keeps related strings adjacent for whoever is translating.
  hits.sort((a, b) => a.line - b.line);
  return { hits, violations };
}

/** Recursively list .js/.jsx files under dir, sorted for deterministic output. */
export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Scan a tree.
 * @returns {{ keys: Map<string, {kind, one?, uses: {file,line}[]}>, violations: [] }}
 *   Keys keep first-encounter order, so the editor lists them in the order the UI
 *   is laid out on disk rather than alphabetically — related strings stay together.
 */
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
      // A key read with tp() anywhere is plural everywhere — it needs the forms.
      if (hit.kind === 'plural') {
        entry.kind = 'plural';
        entry.one ??= hit.one;
      }
      entry.uses.push({ file: rel, line: hit.line });
    }
  }

  return { keys, violations };
}
