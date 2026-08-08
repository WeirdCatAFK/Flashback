#!/usr/bin/env node
/**
 * Translation workbench.
 *
 *   node scripts/translations.js            # extract, then serve the editor
 *   node scripts/translations.js --check    # report only; exits non-zero if incomplete
 *   node scripts/translations.js --open     # serve and open a browser
 *
 * The English source text is the key, so scripts/translations-extract.js scanning src/ui is
 * the authoritative key list. This tool diffs that list against each pack in
 * src/ui/translations/languages/ and sorts the result into three buckets:
 *
 *   missing — in the source, absent from the pack
 *   stale   — in the pack, gone from the source (English was reworded, or deleted)
 *   done    — both
 *
 * The stale bucket is the point. Natural keys are cheap precisely because there is
 * no en.json to maintain, and the cost of that is that editing an English string
 * orphans its translations. Surfacing them as a worklist turns a silent regression
 * into a chore, which is a trade worth making.
 *
 * Dev-only: nothing here ships in the app bundle.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractTree } from './translations-extract.js';

const root       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR     = path.join(root, 'src/ui');
const LOCALES    = path.join(root, 'src/ui/translations/languages');
const EDITOR     = path.join(root, 'scripts/translations-editor.html');
const EXCLUDE    = ['translations/'];       // the module that defines t() calls no keys
const BASE_PORT  = 51330;

// ── Data ──────────────────────────────────────────────────────────────────────

const scan = () => extractTree(UI_DIR, { exclude: EXCLUDE });

function loadPacks() {
  if (!fs.existsSync(LOCALES)) return [];
  return fs.readdirSync(LOCALES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));
      const { _meta = {}, ...entries } = raw;
      return { file: f, code: _meta.code ?? path.basename(f, '.json'), name: _meta.name ?? f, entries };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function savePack(code, name, entries) {
  // Keys are written in source order, so a diff of the pack reads like a diff of
  // the UI rather than an alphabetical reshuffle.
  const ordered = {};
  for (const key of scan().keys.keys()) if (key in entries) ordered[key] = entries[key];
  // Anything left is stale but deliberately kept — preserve it rather than drop it.
  for (const [key, value] of Object.entries(entries)) if (!(key in ordered)) ordered[key] = value;

  const body = { _meta: { code, name }, ...ordered };
  fs.mkdirSync(LOCALES, { recursive: true });
  fs.writeFileSync(path.join(LOCALES, `${code}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** Sort a pack's state against the extracted key list. */
function analyze(keys, pack) {
  const missing = [], done = [];
  for (const key of keys.keys()) (key in pack.entries ? done : missing).push(key);
  const stale = Object.keys(pack.entries).filter((key) => !keys.has(key));
  return { missing, done, stale };
}

// ── --check ───────────────────────────────────────────────────────────────────

function check() {
  const { keys, violations } = scan();
  const packs = loadPacks();
  let failed = false;

  console.log(`\n  ${keys.size} translatable string${keys.size === 1 ? '' : 's'} in src/ui\n`);

  if (violations.length) {
    failed = true;
    console.log(`  ✗ ${violations.length} non-literal call${violations.length === 1 ? '' : 's'}:\n`);
    for (const v of violations) {
      console.log(`      ${v.file}:${v.line}  ${v.reason}`);
      console.log(`        ${v.snippet}`);
    }
    console.log();
  }

  if (!packs.length) console.log('  no language packs in src/ui/translations/languages/\n');

  for (const pack of packs) {
    const { missing, done, stale } = analyze(keys, pack);
    const total = keys.size || 1;
    const pct = Math.round((done.length / total) * 100);
    const ok = !missing.length && !stale.length;
    if (!ok) failed = true;

    console.log(`  ${ok ? '✓' : '✗'} ${pack.name} (${pack.code})  ${pct}%  ${done.length}/${keys.size} translated`);
    if (missing.length) console.log(`      ${missing.length} missing`);
    if (stale.length) {
      console.log(`      ${stale.length} stale (English changed or string removed):`);
      for (const key of stale.slice(0, 10)) console.log(`        ${JSON.stringify(key)}`);
      if (stale.length > 10) console.log(`        … and ${stale.length - 10} more`);
    }
  }

  console.log();
  if (failed) {
    console.log('  Run `npm run translations` to fix.\n');
    process.exitCode = 1;
  }
}

// ── Editor server ─────────────────────────────────────────────────────────────

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

function state() {
  const { keys, violations } = scan();
  return {
    violations,
    keys: [...keys].map(([key, meta]) => ({ key, kind: meta.kind, one: meta.one, uses: meta.uses })),
    packs: loadPacks().map((p) => ({ code: p.code, name: p.name, entries: p.entries })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(EDITOR);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, state());

    if (req.method === 'POST' && url.pathname === '/save') {
      const { code, name, entries } = await readBody(req);
      if (!code || !/^[a-zA-Z-]{2,12}$/.test(code)) return json(res, 400, { error: 'bad locale code' });
      savePack(code, name || code, entries ?? {});
      return json(res, 200, state());
    }

    res.writeHead(404).end('not found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err.message ?? err) });
  }
};

function serve(open) {
  const server = http.createServer(handler);
  let port = BASE_PORT;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + 20) {
      server.listen(++port, '127.0.0.1');
      return;
    }
    console.error(err);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const { keys } = scan();
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Translation workbench — ${keys.size} strings\n  ${url}\n\n  Ctrl+C to stop.\n`);
    if (open) {
      // `start` is a cmd builtin, hence the shell; harmless no-op elsewhere.
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
          : ['xdg-open', [url]];
      spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
    }
  });
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--check')) check();
else serve(args.includes('--open'));
