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
const name = `flashback-server-${pkg.version}-${platform}${WITH_NODE ? '-standalone' : ''}`;
const outRoot = path.join(root, 'dist-server');
const stage = path.join(outRoot, name);

const KNEX_DIALECTS = ['mysql', 'mysql2', 'oracledb', 'pg', 'pg-query-stream', 'sqlite3', 'tedious'];

const NATIVE_PACKAGES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

const EXTERNAL_TREES = ['jsdom'];

const ASSET_PACKAGES = {
    'pdfjs-dist': {
        files: ['package.json'],
        dirs: ['standard_fonts'],
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


fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const bundlePath = path.join(stage, 'server.mjs');

const BANNER = [
    'import{createRequire as __fbCreateRequire}from"node:module";',
    'import{fileURLToPath as __fbFileURLToPath}from"node:url";',
    'import{dirname as __fbDirname}from"node:path";',
    'var require=__fbCreateRequire(import.meta.url);',
    'var __filename=__fbFileURLToPath(import.meta.url);',
    'var __dirname=__fbDirname(__filename);',
].join('');

log(`Bundling src/server/main.js  (minify: ${MINIFY ? 'on' : 'off'})`);
await esbuild.build({
    entryPoints: [path.join(root, 'src/server/main.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundlePath,
    banner: { js: BANNER },
    external: [
        ...NATIVE_PACKAGES,
        ...Object.keys(ASSET_PACKAGES),
        ...Object.keys(ASSET_PACKAGES).map((p) => `${p}/*`),
        ...EXTERNAL_TREES,
        ...EXTERNAL_TREES.map((p) => `${p}/*`),
        ...KNEX_DIALECTS,
    ],
    minify: MINIFY,
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

function dependencyClosure(roots) {
    const NM = path.join(root, 'node_modules');
    const topLevel = new Set();
    const visited = new Set();
    const unresolved = new Set();

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
        log(`    (not hoisted, travelling nested: ${[...unresolved].join(', ')})`);
    }
}

const addon = path.join(stage, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(addon)) {
    throw new Error('better_sqlite3.node not found. Run `npm run rebuild` and package again.');
}

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


fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({
    name: 'flashback-server',
    version: pkg.version,
    private: true,
    type: 'module',
    main: 'server.mjs',
}, null, 2)}\n`);

const IS_WINDOWS = process.platform === 'win32';
const RUNTIME = path.basename(process.execPath);
const LAUNCHER = IS_WINDOWS ? 'flashback-server.cmd' : 'flashback-server.sh';

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
  Everything is under USER_DATA_PATH. Back up the vault's workspace/ and progress.db,
  and accounts.db. Nothing can rebuild them.
`);


if (WITH_NODE) {
    const exe = process.execPath;
    const dest = path.join(stage, path.basename(exe));
    fs.copyFileSync(exe, dest);
    log(`Embedding Node runtime  ${process.version}  ${mb(fs.statSync(dest).size)}`);
}


const staged = dirSize(stage);
log(`\nStaged  ${path.relative(root, stage)}  ${mb(staged)}`);

if (ZIP) {
    const zipPath = path.join(outRoot, `${name}.zip`);
    fs.rmSync(zipPath, { force: true });
    const zip = new AdmZip();
    zip.addLocalFolder(stage, name);

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
