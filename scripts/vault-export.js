#!/usr/bin/env node
/** Zips a vault for npm run vault:import on a server. Close the desktop app first, so no write lands mid-copy. */
import path from 'path';
import { exportVault } from './vaultMove.js';

const [vaultDir, out] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!vaultDir || process.argv.includes('--help')) {
    console.log('Usage: npm run vault:export -- <vault folder> [out.zip]');
    console.log('The vault folder is the one that holds workspace/ and progress.db.');
    process.exit(process.argv.includes('--help') ? 0 : 1);
}

const dir = path.resolve(vaultDir);
const outFile = path.resolve(out ?? `flashback-${path.basename(dir)}-${new Date().toISOString().slice(0, 10)}.zip`);
try {
    const { entries } = exportVault(dir, outFile);
    console.log(`Wrote ${entries} file(s) to ${outFile}`);
    console.log('Copy it to the server and run: npm run vault:import -- <zip>');
} catch (err) {
    console.error(`Export failed: ${err.message}`);
    process.exit(1);
}
