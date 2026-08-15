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
import { buildPdf, buildEpub, buildPng } from './fixtures.js';
import validate from '../src/api/config/validate.js';
import Documents, { pickCaptionTrack, parseJson3Transcript } from '../src/api/access/orchestration/documents.js';
import reader, { MAX_CHARS } from '../src/api/access/orchestration/mcpReader.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/primitives/config.js';

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

    // Each cue's text is > YT_BLOCK_CHARS (500) so it becomes its own transcript
    // block — deterministic block starts (0:00, 0:30, 1:30, 2:30) to check `at`.
    const filler = 'detail '.repeat(80);   // ~560 chars
    const TALK_CUES = [
        { start: 0, dur: 30, text: `ALPHA ${filler}` },
        { start: 30, dur: 30, text: `BRAVO ${filler}` },
        { start: 90, dur: 30, text: `CHARLIE ${filler}` },
        { start: 150, dur: 30, text: `DELTA ${filler}` },
    ];

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

        // A second book, illustrated, so the text assertions above keep their fixture.
        // Spine order is ch1 → plate → ch2, which is the order images must come back in.
        await docs.importFile('illustrated.epub', ROOT, buildEpub([
            {
                href: 'ch1.xhtml', title: 'Cells',
                body: '<p>The cell is the unit of life.</p>'
                    + '<figure><img src="images/fig1.png" alt="A mitochondrion"/>'
                    + '<figcaption>Figure 1. The powerhouse.</figcaption></figure>'
                    // Painted but never declared in the manifest: not ours to serve.
                    + '<img src="images/ghost.png" alt="Undeclared"/>',
            },
            {
                // Image-only page: no prose at all, which is exactly what a plate is.
                href: 'plate.xhtml', title: 'Plate I',
                body: '<img src="images/plate.png"/>',
            },
            {
                href: 'ch2.xhtml', title: 'Light',
                // Percent-encoded, as a file name with a space is stored in the wild.
                body: '<p>Photosynthesis makes glucose.</p><img src="images/fig%202.png" alt="A chloroplast"/>',
            },
        ], [
            { href: 'images/fig1.png' },
            { href: 'images/fig 2.png' },
            { href: 'images/plate.png' },
            // Declared as the cover and referenced by no section — the manifest-only case.
            { href: 'cover.png', cover: true },
            // Same bare name as images/fig1.png in a different directory, which real
            // books do: makes "fig1.png" an ambiguous way to ask for one of them.
            { href: 'plates/fig1.png' },
        ]), { globalHash: crypto.randomUUID() });

        await docs.importFile('notes.md', ROOT, Buffer.from(MD_BODY), { globalHash: crypto.randomUUID() });
        await docs.importFile('page.clip', ROOT, Buffer.from(
            '<div><h1>Clipped</h1><p>Some <b>bold</b> prose.</p><script>evil()</script></div>'), { globalHash: crypto.randomUUID() });

        // An illustrated, noisy clip that has been read for a while: two pictures and a
        // sound already saved into the vault under different headings, one picture still
        // loading from the site it was clipped from (as every asset starts out), and an
        // <audio> whose src sits on a <source> child rather than the element.
        await docs.importFile('article.clip', ROOT, Buffer.from(
            '<h1>Birdsong</h1>'
            + '<p>Opening prose about calls and songs.</p>'
            + '<figure><img src="./media/clip-aaaaaaaaaaaa.png" alt="A wren"/>'
            + '<figcaption>Figure 1. A wren mid-song.</figcaption></figure>'
            + '<audio src="./media/clip-cccccccccccc.mp3" controls></audio>'
            + '<h2>Field recordings</h2>'
            + '<p>More prose under the second heading.</p>'
            + '<img src="./media/clip-bbbbbbbbbbbb.png" alt="A finch"/>'
            + '<img src="https://example.test/too-big.png" alt="Never downloaded"/>'
            + '<audio controls><source src="./media/clip-dddddddddddd.ogg" type="audio/ogg"></audio>'
            // A sound the page publishes as a LINK, with no player of its own — how
            // Wikipedia renders every one of its sounds. Beside it, the two links that
            // must not be mistaken for it: the file's description page (whose URL also
            // ends in a media extension) and an ordinary article link.
            + '<p>Hear it <a href="https://example.test/audio/nightingale.mp3" title="Play audio">Play</a>'
            + '<sup><a href="https://example.test/wiki/File:nightingale.mid">i</a></sup>'
            + ' or read <a href="https://example.test/wiki/Nightingale">the article</a>.</p>',
        ), { globalHash: crypto.randomUUID() });

        // The cached bytes those refs point at. The clipper writes these itself; here
        // they are placed directly so the reader can be tested without the network.
        const mediaDir = docs.files.safePath(path.join(ROOT, 'media'));
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, 'clip-aaaaaaaaaaaa.png'), buildPng(1));
        fs.writeFileSync(path.join(mediaDir, 'clip-bbbbbbbbbbbb.png'), buildPng(2));
        fs.writeFileSync(path.join(mediaDir, 'clip-cccccccccccc.mp3'), Buffer.from('ID3-fake-mp3-bytes'));
        fs.writeFileSync(path.join(mediaDir, 'clip-dddddddddddd.ogg'), Buffer.from('OggS-fake-bytes'));
        await docs.importFile('vid.youtube', ROOT, Buffer.from(JSON.stringify({
            url: 'https://youtu.be/abc', videoId: 'abc', title: 'A Talk', author: 'Someone',
        })), { globalHash: crypto.randomUUID() });
        await docs.importFile('talk.youtube', ROOT, Buffer.from(JSON.stringify({
            url: 'https://youtu.be/xyz', videoId: 'xyz', title: 'Cells Talk', author: 'Prof',
        })), {
            globalHash: crypto.randomUUID(),
            source: { videoId: 'xyz', transcript: TALK_CUES, transcriptMeta: { lang: 'en', kind: 'asr' } },
        });
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

    describe('EPUB images', () => {
        const list = () => reader.images(rel('illustrated.epub'));

        it('lists declared images in reading order, manifest-only ones last', async () => {
            const { total, images } = await list();
            assert.equal(total, 5);
            assert.deepEqual(images.map((i) => i.href), [
                'OEBPS/images/fig1.png',    // ch1
                'OEBPS/images/plate.png',   // the plate page, second in the spine
                'OEBPS/images/fig 2.png',   // ch2, reached through a percent-encoded src
                // Referenced by no section, so these come last, in manifest order.
                'OEBPS/cover.png',
                'OEBPS/plates/fig1.png',
            ]);
            assert.deepEqual(images.map((i) => i.index), [1, 2, 3, 4, 5]);
        });

        it('carries the context that identifies a figure without seeing it', async () => {
            const { images } = await list();
            const fig1 = images.find((i) => i.name === 'fig1.png');
            assert.equal(fig1.alt, 'A mitochondrion');
            assert.equal(fig1.caption, 'Figure 1. The powerhouse.');
            assert.equal(fig1.section, 'Cells');
            assert.equal(fig1.sectionIndex, 1);
            assert.equal(fig1.mediaType, 'image/png');
            assert.ok(fig1.bytes > 0, 'byte size comes off the zip header');
        });

        it('numbers an image by the section it can be read from, not its spine slot', async () => {
            const { images } = await list();
            // ch2 is third in the spine but only the second section with prose, and
            // sectionIndex has to be the number read() accepts.
            const fig2 = images.find((i) => i.name === 'fig 2.png');
            assert.equal(fig2.sectionIndex, 2);
            const res = await reader.read(rel('illustrated.epub'), { index: fig2.sectionIndex });
            assert.match(res.text, /Photosynthesis/);
        });

        it('keeps a plate, with no section number because its page has no prose', async () => {
            const { images } = await list();
            const plate = images.find((i) => i.name === 'plate.png');
            assert.equal(plate.section, 'Plate I', 'the page is still named');
            assert.equal(plate.sectionIndex, null, 'but there is no text unit to address');
        });

        it('flags the cover', async () => {
            const { images } = await list();
            assert.deepEqual(images.filter((i) => i.isCover).map((i) => i.name), ['cover.png']);
        });

        it('ignores an image the manifest does not declare', async () => {
            const { images } = await list();
            assert.ok(!images.some((i) => i.name === 'ghost.png'), 'painted, but undeclared');
        });

        it('reports a count from info without listing them', async () => {
            const info = await reader.info(rel('illustrated.epub'));
            assert.equal(info.images, 5);
            assert.equal(info.sections.length, 2, 'the plate page is not a readable section');
        });

        it('reads one image\'s bytes, however it is spelled', async () => {
            const book = rel('illustrated.epub');
            // buildEpub tints its images by position, so tint 1 is provably the first.
            const full = await reader.imageBuffer(book, 'OEBPS/images/fig1.png');
            assert.equal(full.mediaType, 'image/png');
            assert.equal(full.name, 'fig1.png');
            assert.deepEqual(full.buffer, buildPng(1), 'the actual entry, byte for byte');

            // The section-relative src an author writes in the markup...
            const relative = await reader.imageBuffer(book, 'images/fig1.png');
            assert.deepEqual(relative.buffer, buildPng(1));
            // ...and the bare name, when only one image has it.
            const bare = await reader.imageBuffer(book, 'fig 2.png');
            assert.deepEqual(bare.buffer, buildPng(2));
        });

        it('refuses to guess between two images with the same name', async () => {
            await assert.rejects(
                () => reader.imageBuffer(rel('illustrated.epub'), 'fig1.png'),
                (e) => e.status === 400
                    && /matches 2 images/.test(e.message)
                    && /plates\/fig1\.png/.test(e.message),
            );
        });

        it('refuses an href the manifest does not declare', async () => {
            // The allow-list is the security boundary: without it this reads any entry
            // in the archive, and `..` walks out of it.
            for (const href of ['OEBPS/images/ghost.png', '../../../etc/passwd', 'META-INF/container.xml']) {
                await assert.rejects(
                    () => reader.imageBuffer(rel('illustrated.epub'), href),
                    (e) => e.status === 400 && /No image/.test(e.message),
                    `${href} must not be readable`,
                );
            }
        });

        it('refuses a format that has no images to declare', async () => {
            await assert.rejects(
                () => reader.images(rel('book.pdf')),
                (e) => e.status === 415 && /only EPUBs/.test(e.message),
            );
        });
    });

    describe('clip media', () => {
        const findByName = (media, name) => media.find((m) => m.name === name);

        it('lists a clip\'s pictures and sound in document order, with their context', async () => {
            const { total, media } = await reader.media(rel('article.clip'));

            assert.equal(total, 6, 'two cached images, one uncached image, three sounds');
            assert.deepEqual(media.map((m) => m.name), [
                'clip-aaaaaaaaaaaa.png',
                'clip-cccccccccccc.mp3',
                'clip-bbbbbbbbbbbb.png',
                'too-big.png',
                'clip-dddddddddddd.ogg',
                'nightingale.mp3',
            ], 'document order, sound interleaved with pictures where it appears');

            const wren = findByName(media, 'clip-aaaaaaaaaaaa.png');
            assert.equal(wren.kind, 'image');
            assert.equal(wren.alt, 'A wren');
            assert.equal(wren.caption, 'Figure 1. A wren mid-song.');
            assert.equal(wren.heading, 'Birdsong', 'the h1 it sits under');
            assert.equal(wren.mediaType, 'image/png');

            const finch = findByName(media, 'clip-bbbbbbbbbbbb.png');
            assert.equal(finch.heading, 'Field recordings', 'the nearest PRECEDING heading, not the first');

            const ogg = findByName(media, 'clip-dddddddddddd.ogg');
            assert.equal(ogg.kind, 'audio', 'an <audio> whose src is on a <source> child still counts');
            assert.equal(ogg.mediaType, 'audio/ogg');
        });

        it('counts a link to a sound as sound, and other links as nothing', async () => {
            // Most of the web publishes sound as a link rather than a player, so a list
            // built only from <audio> misses it entirely — a page of pronunciations
            // reads as having no sound on it at all.
            const { media } = await reader.media(rel('article.clip'));

            const linked = findByName(media, 'nightingale.mp3');
            assert.equal(linked.kind, 'audio');
            assert.equal(linked.cached, false, 'it is still on the site it was clipped from');
            assert.equal(linked.href, 'https://example.test/audio/nightingale.mp3');
            assert.equal(linked.heading, 'Field recordings');
            assert.equal(linked.alt, null, 'not "Play audio", which every one of them says');

            const hrefs = media.map((m) => m.href);
            assert.ok(
                !hrefs.some((h) => h.includes('File:nightingale.mid')),
                'a description page is a page about a sound, not a sound',
            );
            assert.ok(!hrefs.some((h) => h.endsWith('/wiki/Nightingale')), 'and prose links are not media');
        });

        it('says which assets are really in the vault, and where', async () => {
            const { media } = await reader.media(rel('article.clip'));

            const cached = findByName(media, 'clip-aaaaaaaaaaaa.png');
            assert.equal(cached.cached, true);
            assert.equal(cached.path, path.join(ROOT, 'media', 'clip-aaaaaaaaaaaa.png'));
            assert.equal(cached.bytes, buildPng(1).length, 'size read from the file on disk');

            // The point of reporting it at all: a picture visible on the page that the
            // clipper could not download is explained, not silently missing.
            const remote = findByName(media, 'too-big.png');
            assert.equal(remote.cached, false);
            assert.equal(remote.path, null);
            assert.equal(remote.bytes, null);
            assert.equal(remote.href, 'https://example.test/too-big.png', 'still addressed by its remote URL');
        });

        it('counts a clip\'s media by kind in info()', async () => {
            const info = await reader.info(rel('article.clip'));
            assert.deepEqual(info.media, { total: 6, images: 3, audio: 3 });
            // A clip with nothing in it reports an empty tally rather than undefined.
            assert.deepEqual((await reader.info(rel('page.clip'))).media, { total: 0, images: 0, audio: 0 });
        });

        it('serves a cached asset\'s bytes by href or bare name', async () => {
            const byHref = await reader.mediaBuffer(rel('article.clip'), './media/clip-bbbbbbbbbbbb.png');
            assert.deepEqual(byHref.buffer, buildPng(2), 'the actual file, byte for byte');
            assert.equal(byHref.mediaType, 'image/png');
            assert.equal(byHref.kind, 'image');

            const byName = await reader.mediaBuffer(rel('article.clip'), 'clip-cccccccccccc.mp3');
            assert.equal(byName.kind, 'audio');
            assert.equal(byName.mediaType, 'audio/mpeg');
            assert.equal(byName.buffer.toString(), 'ID3-fake-mp3-bytes');
        });

        it('refuses an asset still out on the web, rather than fetching it', async () => {
            // This module does no network IO on a caller's behalf, whatever the caller
            // wants; saving one is documents.saveClipAsset, which is a write and says so.
            await assert.rejects(
                () => reader.mediaBuffer(rel('article.clip'), 'https://example.test/too-big.png'),
                (e) => e.status === 400 && /not in the vault/.test(e.message),
            );
        });

        it('refuses an href the clip does not reference', async () => {
            // The allow-list is the security boundary here exactly as it is for a book:
            // without it, a clip becomes a way to read any file in the vault.
            for (const href of ['./media/secret.png', '../../notes.md', '../../../etc/passwd']) {
                await assert.rejects(
                    () => reader.mediaBuffer(rel('article.clip'), href),
                    (e) => e.status === 400 && /No media/.test(e.message),
                    `${href} must not be readable`,
                );
            }
        });

        it('still serves a book through the general media surface', async () => {
            // media()/mediaBuffer() must not have quietly become clip-only.
            const { media } = await reader.media(rel('illustrated.epub'));
            assert.ok(media.length > 0);
            assert.ok(media.every((m) => m.kind === 'image'), 'a book carries pictures only');
            assert.ok(media.every((m) => m.path === null), 'a figure in a zip has no path on disk');
            assert.equal(media[0].section, 'Cells', 'EPUB fields survive the generalization');

            const bytes = await reader.mediaBuffer(rel('illustrated.epub'), 'fig 2.png');
            assert.deepEqual(bytes.buffer, buildPng(2));
        });

        it('refuses a format that carries no media at all', async () => {
            await assert.rejects(
                () => reader.media(rel('notes.md')),
                (e) => e.status === 415 && /EPUBs and saved web clips/.test(e.message),
            );
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
            assert.match(res.text, /fetch_youtube_transcript/, 'points at the tool that fixes it');
        });

        it('rejects an offset past the end with a 400', async () => {
            await assert.rejects(
                () => reader.read(rel('notes.md'), { offset: MD_BODY.length + 10 }),
                (e) => e.status === 400 && /past the end/.test(e.message),
            );
        });
    });

    describe('YouTube transcript', () => {
        it('reports timestamped segments once a transcript is stored', async () => {
            const info = await reader.info(rel('talk.youtube'));
            assert.equal(info.format, 'youtube');
            assert.equal(info.unit, 'segment');
            assert.equal(info.total, 4, 'each long cue is its own block');
            assert.equal(info.extractable, true);
            assert.match(info.note, /at=/, 'note advertises timestamp addressing');
        });

        it('reads a block by index with its timestamp label', async () => {
            const b1 = await reader.read(rel('talk.youtube'));   // defaults to block 1
            assert.equal(b1.index, 1);
            assert.equal(b1.label, '0:00');
            assert.match(b1.text, /ALPHA/);

            const b2 = await reader.read(rel('talk.youtube'), { index: 2 });
            assert.equal(b2.label, '0:30');
            assert.match(b2.text, /BRAVO/);
        });

        it('jumps to the block covering a timestamp via `at`', async () => {
            const at100 = await reader.read(rel('talk.youtube'), { at: 100 });
            assert.equal(at100.index, 3, 'CHARLIE starts at 1:30 (90s), the block covering 100s');
            assert.equal(at100.label, '1:30');
            assert.match(at100.text, /CHARLIE/);

            const at0 = await reader.read(rel('talk.youtube'), { at: 0 });
            assert.equal(at0.index, 1);
            assert.match(at0.text, /ALPHA/);
        });
    });

    describe('youtube transcript parsing (pure)', () => {
        it('parses json3 events into cues, dropping formatting-only events', () => {
            const cues = parseJson3Transcript({
                events: [
                    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
                    { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: '\n' }] },  // formatting → dropped
                    { tStartMs: 2000, dDurationMs: 1000 },                          // no segs → dropped
                    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'again' }] },
                ],
            });
            assert.equal(cues.length, 2);
            assert.deepEqual(cues[0], { start: 0, dur: 1.5, text: 'Hello world' });
            assert.equal(cues[1].start, 3);
            assert.equal(cues[1].text, 'again');
        });

        it('accepts a raw json string', () => {
            const cues = parseJson3Transcript(JSON.stringify({
                events: [{ tStartMs: 500, dDurationMs: 500, segs: [{ utf8: 'hi' }] }],
            }));
            assert.equal(cues.length, 1);
            assert.equal(cues[0].start, 0.5);
        });

        it('prefers a manual track in the requested language', () => {
            const player = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
                { baseUrl: 'a', languageCode: 'en', kind: 'asr' },
                { baseUrl: 'b', languageCode: 'en' },        // manual en
                { baseUrl: 'c', languageCode: 'es' },
            ] } } };
            assert.equal(pickCaptionTrack(player, 'en').baseUrl, 'b');
            assert.equal(pickCaptionTrack(player, 'es').baseUrl, 'c');
            assert.equal(pickCaptionTrack({}, 'en'), null, 'no captions → null');
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
