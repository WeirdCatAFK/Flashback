/**
 * Runs a command against a system-Node build of better-sqlite3, then puts the Electron
 * build back.
 *
 * `npm run dev` compiles better-sqlite3 for Electron's ABI (`build/Debug`); plain Node
 * cannot load that binary and fails with a NODE_MODULE_VERSION mismatch. `run-tests.js`
 * has always solved this for the test suite by hiding the Electron build so `bindings`
 * falls through to a Node-compiled `build/Release`. Any other plain-Node script that
 * touches the database needs the same dance, so it lives here rather than being copied.
 *
 *   1. Rename build/Debug → build/Debug.electron   (hide the Electron binary)
 *   2. npm rebuild better-sqlite3                   (build Release for system Node)
 *   3. Run the command
 *   4. Rename build/Debug.electron → build/Debug    (restore)
 *   5. Delete build/Release
 *
 * The swap has to happen in a PARENT process: better-sqlite3 resolves its binary at import
 * time, so a script cannot fix this for itself.
 *
 * Usage:
 *   node scripts/with-system-sqlite.js node scripts/bench-reviews.js --workers 50
 *
 * Restoration runs on SIGINT too — a Ctrl-C halfway through must not leave the working
 * tree with no Debug build, which would break `npm run dev` until someone noticed.
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'node_modules', 'better-sqlite3', 'build');
const debugDir = path.join(buildDir, 'Debug');
const electronDir = path.join(buildDir, 'Debug.electron');
const releaseDir = path.join(buildDir, 'Release');

const command = process.argv.slice(2);
if (command.length === 0) {
    console.error('Usage: node scripts/with-system-sqlite.js <command> [args...]');
    process.exit(2);
}

let restored = false;
function restore() {
    if (restored) return;
    restored = true;
    if (fs.existsSync(electronDir)) {
        if (fs.existsSync(debugDir)) fs.rmSync(debugDir, { recursive: true, force: true });
        fs.renameSync(electronDir, debugDir);
    }
    if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true });
}

process.on('SIGINT', () => { restore(); process.exit(130); });

if (fs.existsSync(debugDir)) fs.renameSync(debugDir, electronDir);

console.log('Building better-sqlite3 for system Node...');
try {
    execSync('npm rebuild better-sqlite3', { stdio: 'inherit', cwd: root });
} catch {
    restore();
    process.exit(1);
}

const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });

console.log('\nRestoring Electron build...');
restore();

process.exit(result.status ?? 1);
