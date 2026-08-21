/**
 * Packages Flashback Server as a standalone zip.
 *
 * The artifact is one bundled ESM file plus the handful of things that genuinely cannot be
 * bundled. That shape is not a stylistic choice — it is what the alternatives ruled out:
 *
 *   - **Node SEA** (single executable) runs the embedded main as CommonJS ONLY. `main.js`
 *     needs top-level await (it defers every import so that creating the workspace directory
 *     cannot happen before FLASHBACK_VAULT_NAME is applied), and top-level await cannot be
 *     expressed in CommonJS. Verified directly: an ESM SEA builds and injects, then dies with
 *     `SyntaxError: await is only valid in ... modules` at `embedderRunCjs`.
 *   - **esbuild with `--format=esm`** has no such restriction, which is what makes this work.
 *
 * ## What stays outside the bundle, and why
 *
 *   - `better-sqlite3` — a native `.node` addon. Bytes, not JavaScript; nothing can inline it.
 *     Its runtime deps `bindings` and `file-uri-to-path` come along. (`prebuild-install` is an
 *     install-time tool and is deliberately left behind.)
 *   - knex's seven optional dialect drivers (`mysql`, `pg`, `oracledb`, …) are marked external
 *     but NOT shipped. They are not installed here either. knex resolves a driver only when it
 *     opens a connection, and this app never opens one through knex — `SchemaSQL.js` uses it
 *     purely as a DDL string generator (`.toString()`). esbuild emits a lazy `createRequire`
 *     shim for them, so an import that never executes never resolves.
 *
 * ## Honesty about what this protects
 *
 * `--minify` makes the bundle unpleasant to read. It does not make it secret: anyone who has
 * the bytes can recover the logic. If secrecy is the goal, hosting the server yourself is the
 * only real answer. The source map is written OUTSIDE the staging directory on purpose — keep
 * it so you can decode a customer's stack trace; it is not shipped.
 *
 * Usage:
 *   node scripts/package-server.js                 # bundle + zip for this platform
 *   node scripts/package-server.js --with-node     # embed the Node runtime (no prerequisite)
 *   node scripts/package-server.js --no-minify     # readable output, for debugging
 *   node scripts/package-server.js --no-zip        # leave the staging directory only
 */

import { execFileSync } from 'child_process';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MINIFY = !has('--no-minify');
const WITH_NODE = has('--with-node');
const ZIP = !has('--no-zip');

const platform = `${process.platform}-${process.arch}`;
const name = `flashback-server-${pkg.version}-${platform}`;
const outRoot = path.join(root, 'dist-server');
const stage = path.join(outRoot, name);

// knex ships adapters for every SQL dialect it supports and requires them lazily. None are
// installed, none are reachable in this app, and esbuild cannot know that — so they are named
// here rather than discovered by letting the build fail.
const KNEX_DIALECTS = ['mysql', 'mysql2', 'oracledb', 'pg', 'pg-query-stream', 'sqlite3', 'tedious'];

// Packages copied into the artifact as real files. Only the native addon and its runtime
// dependency chain — everything else is inside server.mjs.
const NATIVE_PACKAGES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

// pdfjs cannot be bundled, and the reason is worth stating because it is not obvious:
// `mcpReader._extractPdf` calls `require.resolve('pdfjs-dist/package.json')` to locate the
// `standard_fonts/` directory, and `require.resolve('.../pdf.worker.mjs')` to set
// `GlobalWorkerOptions.workerSrc`. Those are RUNTIME lookups for files on disk. esbuild
// happily inlines pdfjs's JavaScript, and then every PDF read fails with
// "Cannot find module 'pdfjs-dist/package.json'" — which is what happened here before this
// existed. So it ships as a real package, with only the files that are actually loaded:
// the legacy ESM build, its worker, and the fonts. Source maps and the `.min` variants are
// half the directory and none of the need.
// jsdom is the same problem as pdfjs but worse: it locates its own data files (notably
// `browser/default-stylesheet.css`) from `__dirname`. Bundled, `__dirname` points at the
// artifact directory and the lookup lands nowhere — EPUB and clip extraction fail with an
// ENOENT for a stylesheet. Unlike pdfjs there is no short list of files to pick, so it ships
// as a whole package together with its transitive dependency closure (39 packages, ~21 MB).
const EXTERNAL_TREES = ['jsdom'];

const ASSET_PACKAGES = {
    'pdfjs-dist': {
        files: ['package.json'],
        dirs: ['standard_fonts'],
        // `legacy/build` is 13.4 MB whole; these two files are what the code names.
        picks: ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'],
    },
};

const log = (msg) => console.log(msg);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function dirSize(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
    return total;
}

// ─── 1. Bundle ──────────────────────────────────────────────────────────────

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const bundlePath = path.join(stage, 'server.mjs');

// ESM has no `require`, and most of the dependency tree is still CommonJS — express, morgan,
// knex, jsdom and their transitive deps all call `require('node:events')` and friends at load
// time. esbuild emits a shim that FORWARDS to `require` when one exists and throws
// "Dynamic require of X is not supported" when it does not, so in a bare .mjs every one of
// those calls dies. Defining `require` from `createRequire` satisfies the shim.
//
// It is also what resolves the externals: `createRequire(import.meta.url)` resolves relative
// to server.mjs, so `require('better-sqlite3')` finds ./node_modules/better-sqlite3 — which
// is exactly how the artifact is laid out.
// `__dirname`/`__filename` are the same story one level down: CommonJS modules pulled into an
// ESM bundle still reference them, and ESM has neither. Without these, reading an EPUB fails
// with "__dirname is not defined" from inside jsdom's tree — a failure that only appears on
// the formats a markdown smoke test never touches.
const BANNER = [
    'import{createRequire as __fbCreateRequire}from"node:module";',
    'import{fileURLToPath as __fbFileURLToPath}from"node:url";',
    'import{dirname as __fbDirname}from"node:path";',
    'var require=__fbCreateRequire(import.meta.url);',
    'var __filename=__fbFileURLToPath(import.meta.url);',
    'var __dirname=__fbDirname(__filename);',
].join('');

// The JS API rather than the CLI, deliberately: the banner contains quotes and a space, and
// passing it through a Windows shell mangled it into `fromnode:module` — which esbuild then
// read as a second input file. An options object has no quoting layer to get wrong.
log(`Bundling src/server/main.js  (minify: ${MINIFY ? 'on' : 'off'})`);
await esbuild.build({
    entryPoints: [path.join(root, 'src/server/main.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',             // NOT cjs — top-level await depends on it. See the header.
    target: 'node22',
    outfile: bundlePath,
    banner: { js: BANNER },
    // `pdfjs-dist/*` as well as the bare name: esbuild matches externals literally, and the
    // import in mcpReader is a deep one (`pdfjs-dist/legacy/build/pdf.mjs`).
    external: [
        ...NATIVE_PACKAGES,
        ...Object.keys(ASSET_PACKAGES),
        ...Object.keys(ASSET_PACKAGES).map((p) => `${p}/*`),
        ...EXTERNAL_TREES,
        ...EXTERNAL_TREES.map((p) => `${p}/*`),
        ...KNEX_DIALECTS,
    ],
    minify: MINIFY,
    // External so the map never lands in the staging directory and cannot be zipped by
    // accident. Moved out below.
    sourcemap: MINIFY ? 'external' : false,
    logLimit: 0,
    absWorkingDir: root,
});

if (MINIFY) {
    const map = `${bundlePath}.map`;
    if (fs.existsSync(map)) {
        const kept = path.join(outRoot, `${name}.server.mjs.map`);
        fs.renameSync(map, kept);
        log(`  source map kept OUT of the artifact: ${path.relative(root, kept)}`);
    }
}
log(`  server.mjs  ${mb(fs.statSync(bundlePath).size)}`);

// ─── 2. The native addon and its chain ──────────────────────────────────────

// better-sqlite3's package directory carries the full SQLite amalgamation in `deps/` and the
// intermediate object files of whatever build last ran — tens of megabytes that a consumer
// never opens. Only the loader, the manifest and the compiled addon are copied.
function copyNativePackage(name) {
    const from = path.join(root, 'node_modules', name);
    const to = path.join(stage, 'node_modules', name);
    if (!fs.existsSync(from)) throw new Error(`Missing dependency ${name} — run npm install first.`);

    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(path.join(from, 'package.json'), path.join(to, 'package.json'));
    for (const sub of ['lib', 'index.js', 'bindings.js']) {
        const src = path.join(from, sub);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(to, sub), { recursive: true });
    }

    // The compiled addon itself. WHICH runtime it was compiled for is not knowable from the
    // path: `npm rebuild` targets system Node and `electron-builder` targets Electron, and
    // both land in build/Release. Verified below by loading it rather than by assuming.
    const release = path.join(from, 'build', 'Release');
    if (fs.existsSync(release)) {
        const dest = path.join(to, 'build', 'Release');
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.readdirSync(release)) {
            if (f.endsWith('.node')) fs.copyFileSync(path.join(release, f), path.join(dest, f));
        }
    }
}

log('Copying the native addon');
for (const name of NATIVE_PACKAGES) copyNativePackage(name);

/** Copies only the named files/directories of a package that must exist on disk. */
function copyAssetPackage(name, { files = [], dirs = [], picks = [] }) {
    const from = path.join(root, 'node_modules', name);
    const to = path.join(stage, 'node_modules', name);
    if (!fs.existsSync(from)) throw new Error(`Missing dependency ${name} — run npm install first.`);

    for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
        fs.copyFileSync(path.join(from, f), path.join(to, f));
    }
    for (const d of dirs) {
        const src = path.join(from, d);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(to, d), { recursive: true });
    }
    for (const p of picks) {
        const src = path.join(from, p);
        if (!fs.existsSync(src)) throw new Error(`${name}: expected ${p} — the package layout changed.`);
        fs.mkdirSync(path.dirname(path.join(to, p)), { recursive: true });
        fs.copyFileSync(src, path.join(to, p));
    }
}

log('Copying packages that resolve files at runtime');
for (const [name, spec] of Object.entries(ASSET_PACKAGES)) {
    copyAssetPackage(name, spec);
    log(`  ${name}  ${mb(dirSize(path.join(stage, 'node_modules', name)))}`);
}

/**
 * Every package `roots` depend on, transitively, read from the installed tree.
 *
 * npm hoists, so nearly everything is a sibling at the top of node_modules; a package that
 * needed a conflicting version is nested inside its dependent and comes along when that
 * dependent's directory is copied. Anything unresolvable at either location is reported
 * rather than skipped — a silently missing dependency is a runtime crash on someone else's
 * machine.
 */
function dependencyClosure(roots) {
    const NM = path.join(root, 'node_modules');
    const topLevel = new Set();   // names to copy from the top of node_modules
    const visited = new Set();    // absolute directories already walked
    const unresolved = new Set();

    // Walking NAMES is not enough, and the bug it causes is quiet. npm nests a package when
    // it needs a version that conflicts with the hoisted one — `jsdom/node_modules/tough-cookie`
    // here — and a name-only walk cannot see it, so its own dependencies (`tldts`) are never
    // collected. The artifact then builds cleanly and dies on the first EPUB with
    // "Cannot find module 'tldts'". So resolve the way Node does: nearest node_modules first,
    // then the top. Nested packages need no copy of their own — they travel inside the
    // directory of whoever nested them.
    const queue = roots.map((name) => ({ name, dir: path.join(NM, name) }));
    while (queue.length) {
        const { name, dir } = queue.shift();
        if (visited.has(dir)) continue;
        const manifest = path.join(dir, 'package.json');
        if (!fs.existsSync(manifest)) { unresolved.add(name); continue; }
        visited.add(dir);

        if (dir === path.join(NM, name)) topLevel.add(name);

        const deps = JSON.parse(fs.readFileSync(manifest, 'utf-8')).dependencies ?? {};
        for (const dep of Object.keys(deps)) {
            const nested = path.join(dir, 'node_modules', dep);
            queue.push(fs.existsSync(path.join(nested, 'package.json'))
                ? { name: dep, dir: nested }
                : { name: dep, dir: path.join(NM, dep) });
        }
    }
    return { found: topLevel, unresolved };
}

if (EXTERNAL_TREES.length) {
    const { found, unresolved } = dependencyClosure(EXTERNAL_TREES);
    for (const name of found) {
        fs.cpSync(
            path.join(root, 'node_modules', name),
            path.join(stage, 'node_modules', name),
            { recursive: true },
        );
    }
    const treeSize = [...found].reduce(
        (sum, n) => sum + dirSize(path.join(stage, 'node_modules', n)), 0,
    );
    log(`  ${EXTERNAL_TREES.join(', ')} + ${found.size - EXTERNAL_TREES.length} deps  ${mb(treeSize)}`);
    if (unresolved.size) {
        // Nested rather than hoisted is normal and harmless (they travel inside their
        // dependent). Printed so a genuinely absent package is not mistaken for one.
        log(`    (not hoisted, travelling nested: ${[...unresolved].join(', ')})`);
    }
}

const addon = path.join(stage, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(addon)) {
    throw new Error('better_sqlite3.node not found. Run `npm run rebuild` and package again.');
}

// Load the copied addon in a clean plain-Node process. This is the one check that cannot be
// skipped: a native addon carries an ABI (NODE_MODULE_VERSION), Electron's differs from
// Node's, and BOTH builds are written to build/Release. Packaging straight after
// `npm run dist:win` therefore produces a zip that dies on the customer's machine with
// "compiled against a different Node.js version" — which is exactly what happened while this
// script was being written. A path check cannot catch it; loading it can.
try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(addon)})`], { stdio: 'pipe' });
} catch (err) {
    const detail = String(err.stderr || err.message).split('\n').slice(0, 6).join('\n  ');
    throw new Error(
        `The bundled better_sqlite3.node cannot be loaded by this Node (${process.version}):\n\n  ${detail}\n\n` +
        'It is almost certainly compiled for Electron — electron-builder writes its build into\n' +
        'the same build/Release directory. Run `npm run rebuild` to compile for system Node,\n' +
        'then package again. (`npm run dev` will rebuild it for Electron afterwards.)',
    );
}
log(`  better_sqlite3.node  ${mb(fs.statSync(addon).size)}  (loads under ${process.version})`);

// ─── 3. Manifest, launchers, README ─────────────────────────────────────────

fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({
    name: 'flashback-server',
    version: pkg.version,
    private: true,
    // Required: server.mjs is ESM and the launcher runs it by path.
    type: 'module',
    main: 'server.mjs',
}, null, 2)}\n`);

// ONE launcher, for the platform this artifact targets. The zip is already platform-specific
// — better-sqlite3 is a compiled addon — so shipping the other platform's launcher only
// invites someone to run the wrong one. It was also quietly wrong: the name of the embedded
// runtime is `node.exe` on Windows and `node` elsewhere, and both launchers used to hardcode
// the Windows spelling.
const IS_WINDOWS = process.platform === 'win32';
const RUNTIME = path.basename(process.execPath);   // node.exe | node
const LAUNCHER = IS_WINDOWS ? 'flashback-server.cmd' : 'flashback-server.sh';

// `.env` is resolved against the LAUNCHER's directory, not the shell's — `--env-file` takes a
// path relative to the working directory, so a bare `.env` would silently find nothing when
// someone runs the server from anywhere but the extracted folder. `$DIR`/`%~dp0` is the same
// anchor the launcher already uses for `server.mjs` and the default `USER_DATA_PATH`.
//
// `-if-exists` rather than plain `--env-file`: the file is optional here, and plain
// `--env-file` turns a missing one into a hard startup failure. A real environment variable
// still wins over a line in the file, so the file is a set of defaults, not an override.
const ENV_FILE_WIN = '--env-file-if-exists="%~dp0.env"';
const ENV_FILE_SH  = '--env-file-if-exists="$DIR/.env"';

if (IS_WINDOWS) {
    fs.writeFileSync(path.join(stage, LAUNCHER),
        '@echo off\r\n' +
        'REM the environment (which wins). See README.txt and .env.example.\r\n' +
        'REM USER_DATA_PATH decides where the vault lives.\r\n' +
        'if "%USER_DATA_PATH%"=="" set USER_DATA_PATH=%~dp0data\r\n' +
        `${WITH_NODE ? `"%~dp0${RUNTIME}"` : 'node'} ${ENV_FILE_WIN} "%~dp0server.mjs" %*\r\n`);
} else {
    // LF line endings, necessarily: a CRLF shebang gives "bad interpreter: /bin/sh^M".
    // The executable bit is stamped into the zip entry rather than taken from disk — see
    // the zip step, and note that setting it here does nothing at all on Windows.
    fs.writeFileSync(path.join(stage, LAUNCHER),
        '#!/bin/sh\n' +
        '# Flashback Server. Set FLASHBACK_* variables in .env beside this file, or in the\n' +
        '# environment (which wins). See README.txt and .env.example.\n' +
        '# USER_DATA_PATH decides where the vault lives.\n' +
        'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n' +
        ': "${USER_DATA_PATH:=$DIR/data}"\n' +
        'export USER_DATA_PATH\n' +
        `exec ${WITH_NODE ? `"$DIR/${RUNTIME}"` : 'node'} ${ENV_FILE_SH} "$DIR/server.mjs" "$@"\n`,
        { mode: 0o755 });
}

// The template ships INSIDE the zip; a real `.env` never does. Someone copies it, edits it,
// and the launcher picks it up — and an upgrade that replaces the folder does not carry
// their secrets along with it.
fs.copyFileSync(path.join(root, '.env.example'), path.join(stage, '.env.example'));

fs.writeFileSync(path.join(stage, 'README.txt'),
`Flashback Server ${pkg.version}  (${platform})

RUN
  ${IS_WINDOWS ? LAUNCHER : './' + LAUNCHER}
${WITH_NODE
    ? '\n  The Node runtime is included. Nothing else to install.\n'
    : '\n  Requires Node.js 22 on PATH. (Package with --with-node to avoid that.)\n'}
On the FIRST start an author token is printed once. Copy it — only its SHA-256 is stored,
so it cannot be shown again. Use it to add this server as a remote in the desktop app.

CONFIGURE
  Copy .env.example to .env beside this file, or set these in the environment (which wins).

  USER_DATA_PATH              where the vault lives      (default: ./data beside this file)
  FLASHBACK_PORT              port to listen on          (default: 50500)
  FLASHBACK_HOST              interface to bind          (default: 0.0.0.0)
  FLASHBACK_VAULT_NAME        vault directory to serve
  FLASHBACK_ALLOWED_ORIGINS   comma-separated browser origins
  FLASHBACK_USER_NAME         identity new work is stamped with  (set BOTH, before first run)
  FLASHBACK_USER_EMAIL
  FLASHBACK_AUTHOR_TOKEN      supply a token instead of minting one

TLS
  Authentication is a bearer token, and media URLs carry it as a query parameter. Put this
  behind a TLS-terminating reverse proxy. Do not expose it directly.

BACK UP
  Everything is under USER_DATA_PATH. accounts.db is the only file nothing can rebuild:
  it holds the access list and every non-owner's study schedule.

  Full documentation: docs/SERVER.md in the Flashback repository.
`);

// ─── 4. The Node runtime, optionally ────────────────────────────────────────

if (WITH_NODE) {
    const exe = process.execPath;
    const dest = path.join(stage, path.basename(exe));
    fs.copyFileSync(exe, dest);
    log(`Embedding Node runtime  ${process.version}  ${mb(fs.statSync(dest).size)}`);
}

// ─── 5. Zip ─────────────────────────────────────────────────────────────────

const staged = dirSize(stage);
log(`\nStaged  ${path.relative(root, stage)}  ${mb(staged)}`);

if (ZIP) {
    const zipPath = path.join(outRoot, `${name}.zip`);
    fs.rmSync(zipPath, { force: true });
    const zip = new AdmZip();
    zip.addLocalFolder(stage, name);

    // Stamp the Unix permission bits ourselves rather than inheriting them from the build
    // host's filesystem. Windows has no execute bit — `writeFileSync(..., {mode: 0o755})` is
    // silently ignored there — so a zip built on Windows carries mode 666 and a Linux user
    // who unzips it gets "permission denied" from the launcher. Setting it explicitly makes
    // the artifact identical whichever machine produced it.
    //
    // A zip entry's external attributes hold the Unix mode in the high 16 bits.
    const EXECUTABLE = (0o755 << 16) >>> 0;
    const READABLE = (0o644 << 16) >>> 0;
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        entry.header.attr = entry.entryName.endsWith('.sh') ? EXECUTABLE : READABLE;
    }

    zip.writeZip(zipPath);
    log(`Zipped  ${path.relative(root, zipPath)}  ${mb(fs.statSync(zipPath).size)}`);
}

log('\nDone.');
