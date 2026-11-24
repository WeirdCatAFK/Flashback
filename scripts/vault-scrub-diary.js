#!/usr/bin/env node
/** Erases the diary that an older build committed to a vault's Seal history. Close the app or stop the server first. */
import path from 'path';
import { scrubDiary } from './vaultScrub.js';

const [vaultDir] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!vaultDir || process.argv.includes('--help')) {
    console.log('Usage: npm run vault:scrub-diary -- <vault folder>');
    console.log('The vault folder is the one that holds workspace/ and progress.db.');
    process.exit(process.argv.includes('--help') ? 0 : 1);
}

try {
    const { commits, backup } = await scrubDiary(path.resolve(vaultDir));
    if (!commits) {
        console.log('The Seal history holds no diary.');
    } else {
        console.log(`Erased the diary from ${commits} commit(s).`);
        console.log(`The old history, with the diary text, is in ${backup}`);
        console.log('Check the Seal view, then delete that folder.');
    }
} catch (err) {
    console.error(`Scrub failed: ${err.message}`);
    process.exit(1);
}
