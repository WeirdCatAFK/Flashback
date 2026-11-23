import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import Documents, { extractYoutubeId, slugifyName } from '../src/api/access/orchestration/documents.js';
import reader from '../src/api/access/orchestration/mcpReader.js';
import db from '../src/api/access/primitives/database.js';
import validate from '../src/api/config/validate.js';
import { sealTools, sealEmitter } from '../src/api/seal/seal.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const TEST_ROOT = 'ClipTests';

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

const MP3_BYTES = Buffer.from('ID3fake mp3 payload');

const ARTICLE_URL = 'https://example.test/great-article';
const IMG_URL = 'https://example.test/img/photo.png';
const REFUSED_IMG_URL = 'https://example.test/img/refused.png';
const SND_URL = 'https://example.test/audio/call.mp3';
const SND_ALT_URL = 'https://example.test/audio/call.ogg';
const HUGE_SND_URL = 'https://example.test/audio/episode.mp3';
const LINKED_SND_URL = 'https://example.test/audio/chord.mp3';
const FILE_PAGE_URL = 'https://example.test/wiki/File:chord.mid';
const PROSE_LINK_URL = 'https://example.test/wiki/Chord';
const ARTICLE_HTML = `<!doctype html><html><head>
  <title>An Excellent Article</title>
  <meta property="og:site_name" content="Example Times">
</head><body>
  <nav>menu junk that readability drops</nav>
  <article>
    <h1>An Excellent Article</h1>
    <p>${'This is a substantial opening paragraph with plenty of prose so that the readability algorithm treats it as real article content and not boilerplate. '.repeat(3)}</p>
    <p>${'A second meaty paragraph continues the discussion with more sentences, giving the extractor enough signal to lock onto the main content region of the page. '.repeat(3)}</p>
    <figure><img src="/img/photo.png" alt="a photo"><figcaption>A caption</figcaption></figure>
    <figure><img src="/img/refused.png" alt="a picture its host will not hand over"></figure>
    <audio controls>
      <source src="/audio/call.mp3" type="audio/mpeg">
      <source src="/audio/call.ogg" type="audio/ogg">
    </audio>
    <audio src="/audio/episode.mp3" controls></audio>
    <p>Hear it: <span><a href="/audio/chord.mp3" title="Play audio"><span></span><span>Play</span></a></span>
      <sup><a href="/wiki/File:chord.mid" title="File:chord.mid">ⓘ</a></sup>
      and read more <a href="/wiki/Chord">about chords</a>.</p>
    <p>${'A closing paragraph wraps things up and reinforces that this document has a clear, dominant block of readable text worth clipping. '.repeat(3)}</p>
    <script>window.tracker = 1;</script>
  </article>
</body></html>`;

const FETCH_LOG = [];

const realFetch = global.fetch;
function installFetchStub() {
    global.fetch = async (url) => {
        const u = String(url);
        FETCH_LOG.push(u);
        if (u === REFUSED_IMG_URL) {
            return {
                ok: false, status: 429,
                headers: { get: () => null },
                text: async () => 'Too Many Requests',
                arrayBuffer: async () => { throw new Error('must not read a 429 body as bytes'); },
            };
        }
        if (u.startsWith('https://www.youtube.com/oembed')) {
            return {
                ok: true, status: 200,
                json: async () => ({ title: 'Never Gonna Give You Up', author_name: 'Rick Astley', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }),
            };
        }
        if (u === ARTICLE_URL) {
            return { ok: true, status: 200, text: async () => ARTICLE_HTML };
        }
        if (u === IMG_URL) return bytesResponse(PNG_BYTES, 'image/png');
        if (u === SND_URL || u === SND_ALT_URL) return bytesResponse(MP3_BYTES, 'audio/mpeg');
        if (u === LINKED_SND_URL) return bytesResponse(Buffer.concat([MP3_BYTES, Buffer.from('chord')]), 'audio/mpeg');
        if (u === FILE_PAGE_URL) return bytesResponse(Buffer.from('<html>a page about a file</html>'), 'text/html; charset=utf-8');
        if (u === HUGE_SND_URL) {
            return {
                ok: true, status: 200,
                headers: {
                    get: (h) => ({ 'content-type': 'audio/mpeg', 'content-length': String(90 * 1024 * 1024) })[h.toLowerCase()] ?? null,
                },
                arrayBuffer: async () => { throw new Error('must not download a 90 MB file'); },
            };
        }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    };
}

function bytesResponse(buf, contentType) {
    return {
        ok: true, status: 200,
        headers: {
            get: (h) => ({ 'content-type': contentType, 'content-length': String(buf.length) })[h.toLowerCase()] ?? null,
        },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
}

describe('Custom formats: webclip + youtube', () => {
    before(async () => {
        try { if (await docs.exists(TEST_ROOT, true, true)) await docs.delete(TEST_ROOT, true); } catch {  }
        await sealTools.init();
        await docs.createFolder(TEST_ROOT);
        installFetchStub();
    });

    after(async () => {
        global.fetch = realFetch;
        db.close();
        await new Promise((r) => setTimeout(r, 50));
        try { fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true }); }
        catch (e) { console.warn('Teardown warning (safe to ignore):', e.message); }
    });

    describe('helpers', () => {
        it('extractYoutubeId handles common URL shapes', () => {
            assert.equal(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
            assert.equal(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
            assert.equal(extractYoutubeId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
            assert.equal(extractYoutubeId('https://example.com/nope'), null);
        });
        it('slugifyName strips illegal chars and falls back', () => {
            assert.equal(slugifyName('a/b:c*d'), 'a b c d');
            assert.equal(slugifyName('   '), 'clip');
        });
    });

    describe('createYoutube', () => {
        it('creates a .youtube document with source metadata and seals it', async () => {
            const before = (await sealTools.log()).length;
            const { path: relPath, globalHash } = await docs.createYoutube('https://youtu.be/dQw4w9WgXcQ', TEST_ROOT);

            assert.ok(relPath.endsWith('.youtube'), 'file has .youtube extension');
            assert.ok(globalHash && globalHash.length > 0, 'returns a globalHash');

            const meta = docs.files.getMetadata(relPath);
            assert.equal(meta.source.videoId, 'dQw4w9WgXcQ');
            assert.equal(meta.source.title, 'Never Gonna Give You Up');
            assert.ok(Array.isArray(meta.highlights), 'sidecar has a highlights array');

            const body = JSON.parse(docs.files.readFile(relPath).content);
            assert.equal(body.videoId, 'dQw4w9WgXcQ');
            assert.equal(body.author, 'Rick Astley');

            const listing = (await await docs.listFolder(TEST_ROOT)).map((i) => i.name);
            assert.ok(listing.some((n) => n.endsWith('.youtube')), 'shows up in the folder listing');

            const commits = await sealTools.log();
            assert.ok(commits.length > before, 'produced a Seal commit');
            assert.ok(commits[0].commit.message.startsWith('create:'), 'create commit');
        });

        it('rejects an invalid YouTube URL', async () => {
            await assert.rejects(async () => await docs.createYoutube('https://example.com/not-a-video', TEST_ROOT), /Invalid YouTube URL/);
        });
    });

    describe('createClip', () => {
        let relPath;

        before(async () => {
            FETCH_LOG.length = 0;
            ({ path: relPath } = await docs.createClip(ARTICLE_URL, TEST_ROOT));
        });

        it('extracts readable content, sanitizes, and seals', () => {
            assert.ok(relPath.endsWith('.clip'), 'file has .clip extension');

            const { content } = docs.files.readFile(relPath);
            assert.ok(!/<script/i.test(content), 'scripts are stripped');
            assert.ok(/great opening|substantial opening/i.test(content) || content.length > 200, 'has article body');

            const meta = docs.files.getMetadata(relPath);
            assert.equal(meta.source.url, ARTICLE_URL);
            assert.equal(meta.source.siteName, 'Example Times');
            assert.ok(meta.source.title, 'has a title');
        });

        it('costs exactly one request — the page, and nothing else', () => {
            assert.deepEqual(FETCH_LOG, [ARTICLE_URL], 'no asset was requested while clipping');
        });

        it('leaves every asset pointing at the site it came from', () => {
            const { content } = docs.files.readFile(relPath);
            assert.ok(content.includes(IMG_URL), 'the picture still loads from its own host');
            assert.ok(content.includes(SND_URL), 'and so does the sound');
            assert.ok(!content.includes('./media/'), 'nothing was rewritten to a local ref');
            assert.ok(/<audio/i.test(content), 'the audio element survives sanitization');
            assert.ok(content.includes(SND_ALT_URL), 'both encodings are offered until one is saved');
        });

        it('writes no media folder at all', () => {
            const mediaDir = docs.files.safePath(path.join(TEST_ROOT, 'media'));
            assert.ok(!fs.existsSync(mediaDir), 'a clip starts with nothing in the vault but its own text');
        });

        it('finds sound published as a link, and only the links that are sound', async () => {
            const { media } = await reader.media(relPath);
            const hrefs = media.filter((m) => m.kind === 'audio').map((m) => m.href);

            assert.ok(hrefs.includes(LINKED_SND_URL), 'the play link is offered as a sound');
            assert.ok(!hrefs.includes(FILE_PAGE_URL), 'its description page is not');
            assert.ok(!media.some((m) => m.href === PROSE_LINK_URL), 'and an ordinary link is not media at all');
        });

        it('rejects a page that fails to fetch', async () => {
            await assert.rejects(async () => await docs.createClip('https://example.test/missing', TEST_ROOT), /fetch|readable/i);
        });

    });

    describe('saveClipAsset', () => {
        const SAVE_ROOT = `${TEST_ROOT}/saved`;
        const mediaDir = () => docs.files.safePath(path.join(SAVE_ROOT, 'media'));
        const onDisk = () => (fs.existsSync(mediaDir()) ? fs.readdirSync(mediaDir()) : []);
        const body = () => docs.files.readFile(clipPath).content;
        let clipPath;

        before(async () => {
            await docs.createFolder(SAVE_ROOT);
            ({ path: clipPath } = await docs.createClip(ARTICLE_URL, SAVE_ROOT));
            FETCH_LOG.length = 0;
        });

        it('downloads one picture and points the clip at the local copy', async () => {
            const saved = await docs.saveClipAsset(clipPath, IMG_URL);

            assert.equal(saved.kind, 'image');
            assert.equal(saved.alreadySaved, false);
            assert.match(saved.href, /^\.\/media\/clip-[0-9a-f]{12}\.png$/, 'content-addressed name');
            assert.ok(onDisk().includes(saved.name), 'its bytes are really in the vault');
            assert.ok(body().includes(` src="${saved.href}"`), 'the body loads it locally');
            assert.ok(!body().includes(` src="${IMG_URL}"`), 'and no longer from the web');
            assert.ok(body().includes(` data-src="${IMG_URL}"`), 'but remembers where it came from');
        });

        it('registers it in the Media table, content-addressed', async () => {
            const name = body().match(/\.\/media\/(clip-[0-9a-f]+\.png)/)[1];
            const row = await db.prepare('SELECT name, hash FROM Media WHERE name = ?').get(name);
            assert.ok(row, 'the picture has a Media row');
            assert.equal(row.hash.length, 64, 'addressed by sha256');
        });

        it('is a no-op the second time, without touching the network', async () => {
            const href = body().match(/\.\/media\/clip-[0-9a-f]+\.png/)[0];
            const before = FETCH_LOG.length;
            const again = await docs.saveClipAsset(clipPath, href);

            assert.equal(again.alreadySaved, true);
            assert.equal(again.href, href, 'hands back the same reference');
            assert.equal(FETCH_LOG.length, before, 'no request was made');
        });

        it('still answers to the web address it was saved from', async () => {
            const before = FETCH_LOG.length;
            const again = await docs.saveClipAsset(clipPath, IMG_URL);

            assert.equal(again.alreadySaved, true);
            assert.match(again.href, /^\.\/media\//, 'answers with where it lives now');
            assert.equal(FETCH_LOG.length, before, 'and downloads it no second time');
        });

        it('saves a sound and drops the alternative encodings', async () => {
            const saved = await docs.saveClipAsset(clipPath, SND_URL);

            assert.equal(saved.kind, 'audio');
            assert.ok(onDisk().includes(saved.name), 'the sound is in the vault');
            assert.ok(body().includes(saved.href), 'the <source> points at it');
            assert.ok(!body().includes(SND_ALT_URL), 'the second encoding is gone from the body');
            assert.ok(!onDisk().some((n) => n.endsWith('.ogg')), 'and was never downloaded');
        });

        it('saves a sound published as a link, and leaves a real player behind', async () => {
            const saved = await docs.saveClipAsset(clipPath, LINKED_SND_URL);

            assert.equal(saved.kind, 'audio', 'a link to a sound is a sound');
            assert.ok(onDisk().includes(saved.name), 'its bytes are in the vault');
            assert.ok(!body().includes(`href="${LINKED_SND_URL}"`), 'the play link is gone');
            assert.match(body(), /<audio[^>]+ src="\.\/media\/clip-[0-9a-f]+\.mp3"/,
                'replaced by a player pointing at a local copy');
            assert.ok(body().includes(` src="${saved.href}"`), 'and it is this one');
            assert.ok(body().includes(` data-src="${LINKED_SND_URL}"`), 'which remembers where it came from');
            assert.ok(body().includes('Hear it:'), 'and the sentence around it is untouched');
        });

        it('does not mistake a file description page for the recording', async () => {
            await assert.rejects(
                async () => await docs.saveClipAsset(clipPath, FILE_PAGE_URL),
                /not part of this clip/i,
            );
            assert.ok(!FETCH_LOG.includes(FILE_PAGE_URL), 'and never asks for it');
        });

        it('leaves ordinary links alone', async () => {
            await assert.rejects(
                async () => await docs.saveClipAsset(clipPath, PROSE_LINK_URL),
                /not part of this clip/i,
            );
        });

        it('refuses an oversized sound without ever buffering it', async () => {
            await assert.rejects(async () => await docs.saveClipAsset(clipPath, HUGE_SND_URL), /larger than/i);
            assert.ok(body().includes(HUGE_SND_URL), 'a 90 MB episode still plays from its own server');
            assert.ok(!onDisk().some((n) => n.includes('episode')), 'nothing was written for it');
        });

        it('leaves the clip readable when the site refuses the file', async () => {
            await assert.rejects(async () => await docs.saveClipAsset(clipPath, REFUSED_IMG_URL), /refused|429/i);
            assert.ok(body().includes(REFUSED_IMG_URL), 'the picture still loads from its own host');
        });

        it('refuses an address that is not part of this clip', async () => {
            await assert.rejects(
                async () => await docs.saveClipAsset(clipPath, 'https://elsewhere.test/anything.png'),
                /not part of this clip/i,
            );
            assert.ok(!FETCH_LOG.includes('https://elsewhere.test/anything.png'), 'and never requests it');
        });

        it('seals each save as an edit', async () => {
            await sealEmitter.flushEdits();
            const commits = await sealTools.log();
            assert.ok(
                commits.some((c) => c.commit.message.startsWith('edit:') && c.commit.message.includes('.clip')),
                'the rewritten body is versioned like any other edit',
            );
        });

        it('flips the asset from remote to cached for every reader of the clip', async () => {
            const { media } = await reader.media(clipPath);
            const saved = media.filter((m) => m.cached);
            const remote = media.filter((m) => !m.cached);

            assert.equal(saved.length, 3, 'the picture and the two sounds that were saved');
            assert.ok(saved.every((m) => m.path), 'each reports a real path in the vault');
            assert.ok(saved.some((m) => m.kind === 'audio'), 'sound counts as much as pictures');
            assert.ok(remote.length >= 1, 'and the untouched ones are still listed');
            assert.ok(remote.every((m) => /^https?:/.test(m.href)), 'addressed by their web URL');
        });

        it('rejects a document that is not a clip', async () => {
            await assert.rejects(
                async () => await docs.saveClipAsset(path.join(TEST_ROOT, 'anything.youtube'), IMG_URL),
                /not a web clip/i,
            );
        });
    });

    describe('populate an existing (blank) file', () => {
        it('setYoutubeSource fills a hand-created .youtube file', async () => {
            await docs.createFile('blank-video.youtube', TEST_ROOT);
            const relPath = path.join(TEST_ROOT, 'blank-video.youtube');
            assert.equal(docs.files.readFile(relPath).content, '', 'starts empty');

            const res = await docs.setYoutubeSource(relPath, 'https://youtu.be/dQw4w9WgXcQ');
            assert.equal(res.path, relPath);

            const meta = docs.files.getMetadata(relPath);
            assert.equal(meta.source.videoId, 'dQw4w9WgXcQ');
            assert.ok(Array.isArray(meta.highlights), 'highlights array preserved');
            const body = JSON.parse(docs.files.readFile(relPath).content);
            assert.equal(body.videoId, 'dQw4w9WgXcQ');
        });

        it('setClipSource fills a hand-created .clip file', async () => {
            await docs.createFile('blank-page.clip', TEST_ROOT);
            const relPath = path.join(TEST_ROOT, 'blank-page.clip');

            await docs.setClipSource(relPath, ARTICLE_URL);
            const { content } = docs.files.readFile(relPath);
            assert.ok(content.includes(IMG_URL), 'assets still load from their own host');
            assert.ok(!/<script/i.test(content), 'sanitized');
            assert.equal(docs.files.getMetadata(relPath).source.url, ARTICLE_URL);
        });

        it('setYoutubeSource on a missing file rejects', async () => {
            await assert.rejects(async () => await docs.setYoutubeSource(path.join(TEST_ROOT, 'nope.youtube'), 'https://youtu.be/dQw4w9WgXcQ'), /not found/i);
        });
    });
});
