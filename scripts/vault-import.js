#!/usr/bin/env node
/** Imports a zip from npm run vault:export into a new server vault. Stop the server first. */
import path from 'path';
import { applyServerConfig } from '../src/server/serverConfig.js';

const [zip] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!zip || process.argv.includes('--help')) {
    console.log('Usage: npm run vault:import -- <zip>');
    console.log('Stop the server first. The import refuses a vault that already holds documents or progress.');
    process.exit(process.argv.includes('--help') ? 0 : 1);
}

const { config } = applyServerConfig();
const { importVault } = await import('./vaultMove.js');
try {
    const result = await importVault(path.resolve(zip));
    console.log(`Imported into vault "${config.vaultName}".`);
    const { documentsIndexed, flashcards } = result.summary;
    console.log(`Rebuilt the index: ${documentsIndexed} document(s), ${flashcards} card(s).`);
    for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
    console.log('Start the server again.');
} catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exit(1);
}
