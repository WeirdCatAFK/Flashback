/**
 * run-tests.js
 * Runs the test suite against system Node by temporarily hiding the
 * Electron-compiled better-sqlite3 binary (build/Debug) so that `bindings`
 * falls through to the Node-compiled one (build/Release).
 *
 * Flow:
 *   1. Rename build/Debug → build/Debug.electron  (hide Electron binary)
 *   2. npm rebuild better-sqlite3                  (build Release for system Node)
 *   3. Run every test file
 *   4. Rename build/Debug.electron → build/Debug   (restore Electron binary)
 *   5. Delete build/Release                        (remove system Node binary)
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir   = path.join(root, 'node_modules', 'better-sqlite3', 'build');
const debugDir   = path.join(buildDir, 'Debug');
const electronDir = path.join(buildDir, 'Debug.electron');
const releaseDir = path.join(buildDir, 'Release');

const tests = [
    'tests/docs.test.js',
    'tests/graph.test.js',
    'tests/performance.test.js',
    'tests/media.test.js',
    'tests/subs.test.js',
    'tests/seal.test.js',
    'tests/doctor.test.js',
    'tests/tags.test.js',
    'tests/imports.test.js',
    'tests/clips.test.js',
    'tests/fsrs.test.js',
    'tests/fsrs.api.test.js',
    'tests/stats.test.js',
    'tests/api/api.test.js',
    'tests/mcp.test.js',
];

function restore() {
    if (fs.existsSync(electronDir)) {
        if (fs.existsSync(debugDir)) fs.rmSync(debugDir, { recursive: true, force: true });
        fs.renameSync(electronDir, debugDir);
    }
    if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true });
}

// Hide Electron binary
if (fs.existsSync(debugDir)) fs.renameSync(debugDir, electronDir);

// Build for system Node
console.log('Building better-sqlite3 for system Node...');
try {
    execSync('npm rebuild better-sqlite3', { stdio: 'inherit', cwd: root });
} catch {
    restore();
    process.exit(1);
}

// Run tests
let failed = false;
for (const testFile of tests) {
    const fullPath = path.join(root, testFile);
    if (!fs.existsSync(fullPath)) continue;
    console.log(`\n--- ${testFile} ---`);
    const result = spawnSync(process.execPath, ['--test', fullPath], { stdio: 'inherit', cwd: root });
    if (result.status !== 0) failed = true;
}

// Restore Electron binary
console.log('\nRestoring Electron build...');
restore();

process.exit(failed ? 1 : 0);
