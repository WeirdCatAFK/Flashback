// Diary storage-layer tests — summary derivation/idempotency, invisibility to the
// workspace graph/search, entry roundtrip + lazy creation, and own-git-repo commits.
// Standalone: node --test tests/diary.test.js (after better-sqlite3 is built for
// system Node, i.e. run `npm run tests` once first).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import git from 'isomorphic-git';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js';
import Files from '../src/api/access/files.js';
import db from '../src/api/access/database.js';
import query from '../src/api/access/query.js';
import diary from '../src/api/access/diary.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getVaultPath, getWorkspacePath } from '../src/api/access/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const files = new Files();
// Fixture folder name deliberately avoids the substrings 'diary'/'summary' so the
// exclusion assertions below test the real invariant, not the fixture's own name.
const ROOT = 'StudyLogTestWs';
const DAY = '2026-06-01';
const NEXT = '2026-06-02';
const hashes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

const diaryRoot = () => path.join(getVaultPath(), 'diary');

const cleanup = () => {
    try {
        const abs = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
        if (fs.existsSync(diaryRoot())) fs.rmSync(diaryRoot(), { recursive: true, force: true });
    } catch { /* ignore */ }
    // Drop the review logs this suite inserts so counts stay deterministic across runs.
    try { db.prepare("DELETE FROM ReviewLogs WHERE date(timestamp) IN (?, ?)").run(DAY, NEXT); } catch { /* ignore */ }
};

const fcId = (hash) => db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(hash).id;
const insertLog = (fid, outcome, dayIso, hh) =>
    db.prepare(
        'INSERT INTO ReviewLogs (flashcard_id, timestamp, outcome, ease_factor, level) VALUES (?, ?, ?, ?, ?)'
    ).run(fid, `${dayIso}T${hh}:00:00.000Z`, outcome, 2.5, 0);

describe('Diary storage layer', () => {
    before(async () => {
        cleanup();
        await sealTools.init();
        await docs.createFolder(ROOT);
        await docs.importFile('deck.md', ROOT, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: hashes.map((h, i) => ({
                globalHash: h, level: 0, vanillaData: { frontText: `Q${i}`, backText: `A${i}` },
            })),
        });
        // Day DAY: card0 pass, card1 pass, card2 fail twice → 4 reviews, 2 failed, 3 unique.
        insertLog(fcId(hashes[0]), 1, DAY, '10');
        insertLog(fcId(hashes[1]), 1, DAY, '11');
        insertLog(fcId(hashes[2]), 0, DAY, '12');
        insertLog(fcId(hashes[2]), 0, DAY, '13');
    });

    after(() => cleanup());

    it('derives the day summary from ReviewLogs with the v2 schema', async () => {
        const s = await diary.generateSummary(DAY);
        assert.ok(s, 'summary written');
        assert.equal(s.schemaVersion, 2);
        assert.equal(s.date, DAY);
        assert.equal(s.totals.reviews, 4);
        assert.equal(s.totals.uniqueCards, 3);
        assert.equal(s.totals.newCards, 3);
        assert.equal(s.totals.failed, 2);
        assert.equal(s.retention.passRate, 0.5);

        // Every review here is one of its card's first three ⇒ all acquisition, so
        // the day contributes nothing to the review-phase pass rate.
        assert.equal(s.retention.learningCount, 4);
        assert.equal(s.retention.learningPassRate, 0.5);
        assert.equal(s.retention.reviewCount, 0);
        assert.equal(s.retention.reviewPassRate, null);

        const doc = s.byDocument.find(d => d.path.endsWith('deck.md'));
        assert.ok(doc, 'byDocument includes the source document');
        assert.equal(doc.reviews, 4);
        assert.ok(doc.path.includes('/'), 'document path normalized to forward slashes');

        const struggled = s.struggledCards.find(c => c.globalHash === hashes[2]);
        assert.ok(struggled, 'the twice-failed card is listed as struggled');
        assert.equal(struggled.failCount, 2);
        assert.equal(struggled.front, 'Q2');

        assert.equal(s.streak.current, 1);
        assert.equal(s.streak.longest, 1);
        assert.ok(Array.isArray(s.byDeck));

        assert.ok(fs.existsSync(path.join(diaryRoot(), 'summaries', `summary-${DAY}.json`)));
    });

    it('is idempotent: regenerating a past date reproduces the same file (modulo generatedAt)', async () => {
        const a = await diary.generateSummary(DAY);
        const b = await diary.generateSummary(DAY);
        delete a.generatedAt; delete b.generatedAt;
        assert.deepEqual(a, b);
    });

    it('writes nothing for a day with no reviews', async () => {
        const s = await diary.generateSummary(NEXT);
        assert.equal(s, null);
        assert.ok(!fs.existsSync(path.join(diaryRoot(), 'summaries', `summary-${NEXT}.json`)));
    });

    it('lives outside the workspace and never appears in the graph, index, or search', async () => {
        // 1. diary/ is a sibling of workspace/, not inside it.
        const rel = path.relative(getWorkspacePath(), diaryRoot());
        assert.ok(rel.startsWith('..'), 'diary root is outside the workspace root');

        // 2. The canonical file walker never sees it.
        const walk = files.walkWorkspace();
        const walked = [...walk.folders, ...walk.documents].map(e => e.relPath);
        assert.ok(walked.every(p => !p.toLowerCase().includes('diary')), 'walkWorkspace excludes diary');

        // 3. No indexed document lives under the diary directory — so the knowledge
        //    graph (built from Documents/Folders) can never reach a diary file.
        const norm = (p) => (p || '').replace(/\\/g, '/');
        const diaryAbs = norm(diaryRoot());
        const under = query.getAllDocuments().filter(d => norm(d.absolute_path).startsWith(diaryAbs));
        assert.equal(under.length, 0, 'no Documents rows point under diary/');

        // 4. Global search never returns a hit anchored under the diary directory.
        const results = docs.search('summary');
        assert.ok(results.every(r => !norm(r.relative_path).startsWith(diaryAbs)));
    });

    it('saves and reads back a markdown entry, and commits it', async () => {
        const res = await diary.saveEntry(DAY, '# Reflection\nStudied hiragana.');
        assert.equal(res.created, true);
        assert.equal(diary.getEntry(DAY), '# Reflection\nStudied hiragana.');
        assert.ok(fs.existsSync(path.join(diaryRoot(), 'entries', `entry-${DAY}.md`)));
    });

    it('does not create an empty entry file for a day the user never wrote', async () => {
        const res = await diary.saveEntry(NEXT, '   ');
        assert.equal(res.created, false);
        assert.equal(diary.getEntry(NEXT), null);
        assert.ok(!fs.existsSync(path.join(diaryRoot(), 'entries', `entry-${NEXT}.md`)));
    });

    it('versions diary files in its own git repo', async () => {
        const commits = await git.log({ fs, dir: diaryRoot() });
        assert.ok(commits.length >= 2, 'summary + entry each produced a commit');
        assert.ok(commits.some(c => c.commit.message.startsWith('summary:')));
        assert.ok(commits.some(c => c.commit.message.startsWith('entry:')));
    });

    it('lists diary dates newest-first with per-kind flags', () => {
        const list = diary.list();
        const day = list.find(d => d.date === DAY);
        assert.ok(day && day.hasSummary && day.hasEntry);
        // Descending order.
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].date >= list[i].date);
    });
});
