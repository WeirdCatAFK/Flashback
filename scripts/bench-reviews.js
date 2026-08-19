/**
 * Review-path benchmark — how many concurrent studiers can one Flashback API sustain?
 *
 * This exists to answer one question with a number instead of an estimate: the data layer
 * serializes every statement through one queue per store (see `sqliteAdapter.js`), so a
 * study group's reviews run back to back rather than in parallel. Is that queue anywhere
 * near being the bottleneck at study-group scale, or is it three orders of magnitude away?
 *
 * The answer decides whether the server needs a concurrent-write database (Postgres) or
 * whether SQLite is fine, so the measurement has to be honest about what it includes:
 *
 *   - It goes over real HTTP against a real `Api` instance, so Express, JSON parsing, the
 *     auth lookup and the route's card-health call are all in the number. That is the
 *     figure a deployment actually gets.
 *   - It runs READER accounts by default. A non-owner's review is the interesting case:
 *     it writes no sidecar and arms no Seal commit (`documents.submitReview` returns early),
 *     so it is pure database work — exactly the traffic a concurrent engine would help.
 *     `--owner` runs the same load as the Author for comparison, which drags the git commit
 *     path in and is expected to be far slower.
 *   - The document is created NESTED (`--depth`, default 4) because `propagatePresence`
 *     walks the folder tree to the root after every review. Benchmarking a document at the
 *     workspace root would hide the cost this is meant to expose.
 *
 * Usage:
 *   node scripts/bench-reviews.js                       # default sweep: 1, 10, 50, 200
 *   node scripts/bench-reviews.js --workers 50          # one concurrency level
 *   node scripts/bench-reviews.js --reviews 400 --depth 6
 *   node scripts/bench-reviews.js --owner               # Author instead of readers
 *   node scripts/bench-reviews.js --label "after fix"   # tag the run in the output
 *
 * It builds a throwaway vault under `data_bench/` and deletes it on the way out, so it
 * never touches `./data` or a real install.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';

// ─── Arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const CARDS = Number(flag('cards', 60));
const DEPTH = Number(flag('depth', 4));
const REVIEWS_PER_WORKER = Number(flag('reviews', 40));
const AS_OWNER = has('owner');
const LABEL = flag('label', AS_OWNER ? 'owner' : 'readers');
const WORKER_SWEEP = flag('workers', null)
    ? [Number(flag('workers', null))]
    : [1, 10, 50, 200];

// `--root` matters more than it looks. A vault under a synced folder (OneDrive, Dropbox)
// pays that sync's cost on every WAL commit, and this repo happens to live in one — so a
// default-path run measures the developer's filesystem, not the server's. Point it at a
// plain local disk for any number you intend to quote.
const ROOT = path.resolve(flag('root', path.join(process.cwd(), 'data_bench')));
process.env.USER_DATA_PATH = ROOT;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// Imports are hoisted, and every one of these resolves its paths from USER_DATA_PATH at
// import time — so the assignment above has to happen before they load. Dynamic import is
// what makes that ordering real rather than accidental.
const { default: validate } = await import('../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const accounts = await import('../src/api/access/primitives/accounts.js');
const { ensureManifest } = await import('../src/api/access/primitives/vault.js');
const { sealTools, sealEmitter } = await import('../src/api/seal/seal.js');
const { default: Api } = await import('../src/api/api.js');
const { ROLES } = await import('../src/shared/roles.js');

// ─── Statistics ─────────────────────────────────────────────────────────────

/** Percentile of an already-sorted array, nearest-rank. */
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const fmt = (n, digits = 1) => n.toFixed(digits).padStart(8);

// ─── Setup ──────────────────────────────────────────────────────────────────

const AUTHOR_TOKEN = 'bench-author-token-0123456789abcdef';
const docs = new Documents();

/** `Bench/Level1/Level2/...` — a folder chain `depth` deep for presence to walk back up. */
function folderChain(depth) {
    const parts = ['Bench'];
    for (let i = 1; i < depth; i++) parts.push(`Level${i}`);
    return parts;
}

async function seed() {
    ensureManifest();
    await sealTools.init();

    const author = await accounts.ensureLocalAuthor(AUTHOR_TOKEN);

    const parts = folderChain(DEPTH);
    let parent = '';
    for (const part of parts) {
        await docs.createFolder(part, parent);
        parent = parent ? path.join(parent, part) : part;
    }

    const hashes = Array.from({ length: CARDS }, () => crypto.randomUUID());
    await docs.importFile('deck.md', parent, Buffer.from('# Bench'), {
        globalHash: crypto.randomUUID(),
        flashcards: hashes.map((h, i) => ({
            globalHash: h,
            level: 0,
            vanillaData: { frontText: `Q${i}`, backText: `A${i}` },
        })),
    });

    return { author, docRel: path.join(parent, 'deck.md'), hashes };
}

/**
 * One token per worker. Distinct accounts rather than one shared token because the whole
 * point is concurrent WRITERS: sharing an account would have every worker contending on the
 * same CardProgress rows, which measures row contention rather than throughput.
 */
async function makeReaderTokens(count) {
    const tokens = [];
    for (let i = 0; i < count; i++) {
        const account = await accounts.createAccount({
            name: `Bench Reader ${i}`,
            email: `bench+${i}+${Date.now()}@example.invalid`,
            role: ROLES.READER,
        });
        const { token } = await accounts.issueToken(account.id, 'bench');
        tokens.push(token);
    }
    return tokens;
}

// ─── The load ───────────────────────────────────────────────────────────────

/**
 * Fires `workers` concurrent studiers, each posting `REVIEWS_PER_WORKER` reviews in series.
 * One request in flight per worker is the realistic shape: a person answers a card, waits
 * for the response, sees the next card.
 */
async function runLoad({ baseUrl, tokens, docRel, hashes, workers }) {
    const latencies = [];
    let failures = 0;
    let firstFailure = null;

    const worker = async (w) => {
        const token = tokens[w % tokens.length];
        for (let i = 0; i < REVIEWS_PER_WORKER; i++) {
            // Round-robin offset by worker so concurrent studiers are on different cards.
            const hash = hashes[(w + i * 7) % hashes.length];
            const started = performance.now();
            let res;
            try {
                res = await fetch(`${baseUrl}/api/srs/review`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                        path: docRel,
                        flashcardHash: hash,
                        algorithm: 'leitner',
                        outcome: 1,
                        easeFactor: 2.5,
                        newLevel: 1 + (i % 5),
                    }),
                });
            } catch (err) {
                failures++;
                firstFailure ??= err.message;
                continue;
            }
            latencies.push(performance.now() - started);
            if (!res.ok) {
                failures++;
                firstFailure ??= `${res.status} ${await res.text()}`;
            }
        }
    };

    const started = performance.now();
    await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
    const elapsed = performance.now() - started;

    latencies.sort((a, b) => a - b);
    return {
        elapsed,
        count: latencies.length,
        throughput: (latencies.length / elapsed) * 1000,
        p50: pct(latencies, 0.50),
        p95: pct(latencies, 0.95),
        p99: pct(latencies, 0.99),
        max: latencies[latencies.length - 1],
        failures,
        firstFailure,
    };
}

// ─── Main ───────────────────────────────────────────────────────────────────

const { docRel, hashes } = await seed();

// morgan accepts a format FUNCTION, and one returning null logs nothing. Per-request
// logging would be both noise in the table and a measurable share of what we are timing.
const api = new Api({ port: 0, logFormat: () => null, apiToken: AUTHOR_TOKEN });
const server = await api.start();
const baseUrl = `http://localhost:${server.address().port}`;

const maxWorkers = Math.max(...WORKER_SWEEP);
const tokens = AS_OWNER ? [AUTHOR_TOKEN] : await makeReaderTokens(maxWorkers);

console.log('');
console.log(`Flashback review benchmark — ${LABEL}`);
console.log(`  scope        ${AS_OWNER ? 'OWNER (writes sidecar + Seal commit)' : 'READERS (no file writes)'}`);
console.log(`  document     ${docRel}  (folder depth ${DEPTH})`);
console.log(`  cards        ${CARDS}`);
console.log(`  per worker   ${REVIEWS_PER_WORKER} reviews`);
console.log('');
console.log('  workers   reviews    wall(ms)     rev/s     p50(ms)   p95(ms)   p99(ms)   max(ms)  fail');
console.log('  ' + '-'.repeat(94));

const results = [];
for (const workers of WORKER_SWEEP) {
    const r = await runLoad({ baseUrl, tokens, docRel, hashes, workers });
    results.push({ workers, ...r });
    console.log(
        `  ${String(workers).padStart(7)}   ${String(r.count).padStart(7)}   ` +
        `${fmt(r.elapsed, 0)}  ${fmt(r.throughput)}   ${fmt(r.p50)}  ${fmt(r.p95)}  ` +
        `${fmt(r.p99)}  ${fmt(r.max)}  ${String(r.failures).padStart(4)}`
    );
    if (r.firstFailure) console.log(`            first failure: ${r.firstFailure.slice(0, 120)}`);
}

const peak = results.reduce((a, b) => (b.throughput > a.throughput ? b : a));
console.log('');
console.log(`  Peak sustained: ${peak.throughput.toFixed(1)} reviews/sec at ${peak.workers} concurrent studiers.`);
console.log('');

// ─── Teardown ───────────────────────────────────────────────────────────────

await sealEmitter.quiesce();
await api.stop();
db.close();
accounts.closeAccounts();
await new Promise((r) => setTimeout(r, 100));
try {
    fs.rmSync(ROOT, { recursive: true, force: true });
} catch (err) {
    console.warn(`Teardown warning (safe to ignore): ${err.message}`);
}
process.exit(0);
