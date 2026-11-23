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
