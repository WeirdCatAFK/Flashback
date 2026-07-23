// mcpReader tests — server-side text extraction for documents the app renders but
// cannot decode as text (PDF, EPUB, web clips), plus char-window reads of text files.
// The PDF/EPUB fixtures are synthesized by tests/fixtures.js.
// Standalone: node --test tests/mcpReader.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';
import { buildPdf, buildEpub } from './fixtures.js';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js';
import reader, { MAX_CHARS } from '../src/api/access/mcpReader.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const ROOT = 'ReaderTestWorkspace';
const rel = (name) => `${ROOT}/${name}`;

// Delete through the orchestrator so the DB rows go with the files — an fs-only
// cleanup leaves orphaned Documents rows that break the NEXT run of this file.
const rmWorkspace = async () => {
    try { await docs.delete(ROOT, true); } catch { /* not indexed */ }
    try {
        const absPath = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    } catch { /* ignore */ }
};

describe('mcpReader', () => {
    const MD_BODY = `# Notes\n\n${'lorem ipsum dolor sit amet. '.repeat(60)}`;
    // Every sentence is unique, so a windowed read can be checked for exact
    // reassembly — periodic filler would make any overlap check meaningless.
    const LONG = Array.from(
        { length: Math.ceil((MAX_CHARS * 1.5) / 40) },
        (_, i) => `Sentence ${i} of the long chapter body.`,
    ).join(' ');

    before(async () => {
        await rmWorkspace();
        await sealTools.init();
        await docs.createFolder(ROOT);

        await docs.importFile('book.pdf', ROOT, buildPdf([
            ['Page one about mitochondria.'],
            ['Page two about chloroplasts.'],
            ['Page three about ribosomes.'],
        ]), { globalHash: crypto.randomUUID() });

        await docs.importFile('book.epub', ROOT, buildEpub([
            { href: 'ch1.xhtml', title: 'Chapter One', body: '<h1>Chapter One</h1><p>The cell is the unit of life.</p><p>Second paragraph.</p>' },
            { href: 'ch2.xhtml', title: 'Chapter Two', body: '<p>Photosynthesis<br/>makes glucose.</p><script>evil()</script>' },
            { href: 'ch3.xhtml', title: 'Long Chapter', body: `<p>${LONG}</p>` },
        ]), { globalHash: crypto.randomUUID() });

        await docs.importFile('notes.md', ROOT, Buffer.from(MD_BODY), { globalHash: crypto.randomUUID() });
        await docs.importFile('page.clip', ROOT, Buffer.from(
            '<div><h1>Clipped</h1><p>Some <b>bold</b> prose.</p><script>evil()</script></div>'), { globalHash: crypto.randomUUID() });
        await docs.importFile('vid.youtube', ROOT, Buffer.from(JSON.stringify({
            url: 'https://youtu.be/abc', videoId: 'abc', title: 'A Talk', author: 'Someone',
        })), { globalHash: crypto.randomUUID() });
        await docs.importFile('pic.png', ROOT, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
            { globalHash: crypto.randomUUID() });
    });

    after(async () => rmWorkspace());

    describe('PDF', () => {
        it('reports pages and reads one at a time', async () => {
            const info = await reader.info(rel('book.pdf'));
            assert.equal(info.format, 'pdf');
            assert.equal(info.unit, 'page');
            assert.equal(info.total, 3);
            assert.equal(info.extractable, true);

            const p1 = await reader.read(rel('book.pdf'));   // defaults to page 1
            assert.equal(p1.index, 1);
            assert.equal(p1.label, 'p. 1');
            assert.match(p1.text, /mitochondria/);
            assert.ok(!/chloroplasts/.test(p1.text), 'only the requested page');
            assert.equal(p1.hasMore, true);
            assert.equal(p1.next, 2);
        });

        it('reads several pages in one call and ends cleanly', async () => {
            const res = await reader.read(rel('book.pdf'), { index: 2, count: 2 });
            assert.match(res.text, /chloroplasts/);
            assert.match(res.text, /ribosomes/);
            assert.match(res.text, /\[p\. 3\]/, 'each page is labelled inline');
            assert.equal(res.hasMore, false);
            assert.equal(res.next, null);
        });

        it('rejects an out-of-range page with a 400', async () => {
            await assert.rejects(
                () => reader.read(rel('book.pdf'), { index: 99 }),
                (e) => e.status === 400 && /out of range/.test(e.message),
            );
        });
    });

    describe('EPUB', () => {
        it('lists spine sections with their titles', async () => {
            const info = await reader.info(rel('book.epub'));
            assert.equal(info.format, 'epub');
            assert.equal(info.unit, 'section');
            assert.equal(info.total, 3);
            assert.equal(info.sections[0].label, 'Chapter One');
            assert.equal(info.sections[1].index, 2);
        });

        it('reads a section by number, stripping markup and keeping breaks', async () => {
            const res = await reader.read(rel('book.epub'), { index: 1 });
            assert.equal(res.label, 'Chapter One');
            assert.match(res.text, /The cell is the unit of life\./);
            assert.ok(!res.text.includes('<p>'), 'no markup survives');
            assert.match(res.text, /life\.\n+Second paragraph\./, 'paragraph break preserved');
        });

        it('reads a section by its spine href and drops scripts', async () => {
            const res = await reader.read(rel('book.epub'), { index: 'ch2.xhtml' });
            assert.equal(res.index, 2);
            assert.match(res.text, /Photosynthesis\nmakes glucose\./, '<br/> became a newline');
            assert.ok(!res.text.includes('evil'), 'script content is not prose');
        });

        it('rejects an unknown href with a 400', async () => {
            await assert.rejects(
                () => reader.read(rel('book.epub'), { index: 'nope.xhtml' }),
                (e) => e.status === 400 && /No section/.test(e.message),
            );
        });

        it('cuts a section larger than the response cap and resumes inside it', async () => {
            // Responses carry a "[label]\n" header; the body is what reassembles.
            const body = (res) => res.text.slice(res.text.indexOf('\n') + 1);

            const first = await reader.read(rel('book.epub'), { index: 3 });
            assert.equal(first.truncated, true);
            assert.ok(first.text.length <= MAX_CHARS, 'response stays under the cap');
            assert.equal(first.next, 3, 'resumes on the same section');
            assert.equal(first.nextCharOffset, body(first).length);

            const second = await reader.read(rel('book.epub'), { index: 3, charOffset: first.nextCharOffset });
            assert.ok(second.text.length > 0);
            assert.equal(second.truncated, false, 'the remainder fits');
            assert.equal(second.hasMore, false, 'and it was the last section');

            // The two windows are contiguous and lossless: no gap, no repeat.
            assert.equal(body(first) + body(second), LONG);
        });
    });

    describe('text formats', () => {
        it('walks a markdown body in character windows exactly once', async () => {
            const info = await reader.info(rel('notes.md'));
            assert.equal(info.unit, 'chars');
            assert.equal(info.total, MD_BODY.length);

            let assembled = '';
            let offset = 0;
            let guard = 0;
            for (;;) {
                const res = await reader.read(rel('notes.md'), { offset, limit: 400 });
                assembled += res.text;
                if (!res.hasMore) break;
                offset = res.next;
                assert.ok(++guard < 100, 'pagination terminates');
            }
            assert.equal(assembled, MD_BODY, 'the windows reassemble the exact body');
        });

        it('flattens a web clip to prose', async () => {
            const res = await reader.read(rel('page.clip'));
            assert.equal(res.format, 'clip');
            assert.equal(res.text, 'Clipped\n\nSome bold prose.');
        });

        it('describes a YouTube stub instead of pretending it has a transcript', async () => {
            const res = await reader.read(rel('vid.youtube'));
            assert.match(res.text, /A Talk/);
            assert.match(res.text, /no transcript/i);
        });

        it('rejects an offset past the end with a 400', async () => {
            await assert.rejects(
                () => reader.read(rel('notes.md'), { offset: MD_BODY.length + 10 }),
                (e) => e.status === 400 && /past the end/.test(e.message),
            );
        });
    });

    describe('refusals', () => {
        it('415s a format with no readable text', async () => {
            await assert.rejects(
                () => reader.read(rel('pic.png')),
                (e) => e.status === 415 && /no readable text/.test(e.message),
            );
        });

        it('404s a document that does not exist', async () => {
            await assert.rejects(
                () => reader.info(rel('ghost.pdf')),
                (e) => e.status === 404,
            );
        });

        it('refuses to escape the workspace', async () => {
            await assert.rejects(() => reader.read('../../../etc/passwd'));
        });
    });

    describe('cache', () => {
        it('reuses an extraction and drops it when the file changes', async () => {
            const target = rel('cached.md');
            await docs.importFile('cached.md', ROOT, Buffer.from('first version'), { globalHash: crypto.randomUUID() });

            const before = await reader.read(target);
            assert.equal(before.text, 'first version');
            const size = reader._cache.size;

            await reader.read(target);
            assert.equal(reader._cache.size, size, 'a second read adds no new cache entry');

            // Rewrite through the real update path: mtime+size change invalidates.
            await docs.updateFile(target, 'second version, longer than the first', null);
            const after = await reader.read(target);
            assert.equal(after.text, 'second version, longer than the first', 'stale text is never served');
        });
    });
});
