import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import Documents, { extractYoutubeId, slugifyName } from '../src/api/access/orchestration/documents.js';
import reader from '../src/api/access/orchestration/mcpReader.js';
import db from '../src/api/access/primitives/database.js';
import validate from '../src/api/config/validate.js';
import { sealTools } from '../src/api/seal/seal.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const TEST_ROOT = 'ClipTests';

// 1×1 transparent PNG
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

const MP3_BYTES = Buffer.from('ID3fake mp3 payload');

const ARTICLE_URL = 'https://example.test/great-article';
const IMG_URL = 'https://example.test/img/photo.png';
// Sound the clipper should cache, an alternative encoding of the same recording that
// it should therefore drop, and one too large to be worth pulling into the vault.
const SND_URL = 'https://example.test/audio/call.mp3';
const SND_ALT_URL = 'https://example.test/audio/call.ogg';
const HUGE_SND_URL = 'https://example.test/audio/episode.mp3';
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
    <audio controls>
      <source src="/audio/call.mp3" type="audio/mpeg">
      <source src="/audio/call.ogg" type="audio/ogg">
    </audio>
    <audio src="/audio/episode.mp3" controls></audio>
    <p>${'A closing paragraph wraps things up and reinforces that this document has a clear, dominant block of readable text worth clipping. '.repeat(3)}</p>
    <script>window.tracker = 1;</script>
  </article>
</body></html>`;

// Deterministic offline fetch stub covering the article page, its image, and the
// YouTube oEmbed endpoint.
const realFetch = global.fetch;
function installFetchStub() {
    global.fetch = async (url) => {
        const u = String(url);
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
        if (u === HUGE_SND_URL) {
            // A podcast episode: declares its size and is never buffered. `arrayBuffer`
            // throws so the test fails loudly if the pre-check is ever removed.
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
        try { if (docs.exists(TEST_ROOT, true, true)) await docs.delete(TEST_ROOT, true); } catch { /* ok */ }
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

            const listing = docs.listFolder(TEST_ROOT).map((i) => i.name);
            assert.ok(listing.some((n) => n.endsWith('.youtube')), 'shows up in the folder listing');

            const commits = await sealTools.log();
            assert.ok(commits.length > before, 'produced a Seal commit');
            assert.ok(commits[0].commit.message.startsWith('create:'), 'create commit');
        });

        it('rejects an invalid YouTube URL', async () => {
            await assert.rejects(() => docs.createYoutube('https://example.com/not-a-video', TEST_ROOT), /Invalid YouTube URL/);
        });
    });

    describe('createClip', () => {
        it('extracts readable content, caches images, sanitizes, and seals', async () => {
            const { path: relPath } = await docs.createClip(ARTICLE_URL, TEST_ROOT);

            assert.ok(relPath.endsWith('.clip'), 'file has .clip extension');

            const { content } = docs.files.readFile(relPath);
            assert.ok(!/<script/i.test(content), 'scripts are stripped');
            assert.ok(/great opening|substantial opening/i.test(content) || content.length > 200, 'has article body');
            assert.ok(content.includes('./media/clip-'), 'image src rewritten to local ./media ref');

            const meta = docs.files.getMetadata(relPath);
            assert.equal(meta.source.url, ARTICLE_URL);
            assert.equal(meta.source.siteName, 'Example Times');
            assert.ok(meta.source.title, 'has a title');

            // Image cached into the folder's media/ dir
            const mediaDir = docs.files.safePath(path.join(TEST_ROOT, 'media'));
            const cached = fs.readdirSync(mediaDir).filter((n) => n.startsWith('clip-'));
            assert.ok(cached.length >= 1, 'at least one image cached to disk');
        });

        it('rejects a page that fails to fetch', async () => {
            await assert.rejects(() => docs.createClip('https://example.test/missing', TEST_ROOT), /fetch|readable/i);
        });

    });

    // A clip is named after the page title, so clipping the same article twice would
    // collide. These share one capture in a folder of its own and assert about it.
    describe('createClip: audio', () => {
        const AUDIO_ROOT = `${TEST_ROOT}/audio`;
        let clipPath;
        let content;
        let onDisk;

        before(async () => {
            await docs.createFolder(AUDIO_ROOT);
            ({ path: clipPath } = await docs.createClip(ARTICLE_URL, AUDIO_ROOT));
            content = docs.files.readFile(clipPath).content;
            onDisk = fs.readdirSync(docs.files.safePath(path.join(AUDIO_ROOT, 'media')));
        });

        it('keeps the audio element and points it at the cached file', () => {
            // The regression this pins: sanitize-html silently dropping <audio>, which is
            // what made a clipped pronunciation vanish before it was allow-listed.
            assert.ok(/<audio/i.test(content), 'the audio element survives sanitization');

            const local = content.match(/\.\/media\/(clip-[0-9a-f]+\.mp3)/);
            assert.ok(local, 'a sound was rewritten to a local ./media ref');
            assert.ok(onDisk.includes(local[1]), 'and its bytes are really in the vault');
        });

        it('downloads one encoding of a recording, not every alternative', () => {
            // A page offering the same sound as mp3 + ogg costs one file, and the
            // alternative <source> is removed so the browser cannot prefer the remote one.
            assert.ok(!onDisk.some((n) => n.endsWith('.ogg')), 'the second encoding is not downloaded');
            assert.ok(!content.includes(SND_ALT_URL), 'and its remote <source> is gone from the body');
        });

        it('leaves an oversized sound remote instead of pulling it into the vault', () => {
            // The fetch stub throws if that response's body is ever read, so getting this
            // far at all proves the Content-Length pre-check ran before buffering.
            assert.ok(content.includes(HUGE_SND_URL), 'a 90 MB episode still plays from its own server');
            assert.ok(!onDisk.some((n) => n.includes('episode')), 'nothing was written for it');
        });

        it('registers cached audio in the Media table like any other asset', () => {
            const name = content.match(/\.\/media\/(clip-[0-9a-f]+\.mp3)/)[1];
            const row = db.prepare('SELECT name, hash FROM Media WHERE name = ?').get(name);
            assert.ok(row, 'the sound has a Media row');
            assert.equal(row.hash.length, 64, 'content-addressed by sha256, same as an image');
        });

        it('makes its media discoverable through the reader, sound included', async () => {
            // The other half of the feature: what the clipper downloaded is what the
            // card form's picker and the MCP tools can offer.
            const { media } = await reader.media(clipPath);
            const kinds = media.map((m) => m.kind);
            assert.ok(kinds.includes('image'), 'the cached picture is listed');
            assert.ok(kinds.includes('audio'), 'the cached sound is listed');
            assert.ok(
                media.some((m) => m.kind === 'audio' && m.cached && m.path),
                'and the sound reports a real path in the vault',
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

        it('setClipSource fills a hand-created .clip file with cached images', async () => {
            await docs.createFile('blank-page.clip', TEST_ROOT);
            const relPath = path.join(TEST_ROOT, 'blank-page.clip');

            await docs.setClipSource(relPath, ARTICLE_URL);
            const { content } = docs.files.readFile(relPath);
            assert.ok(content.includes('./media/clip-'), 'image cached + rewritten');
            assert.ok(!/<script/i.test(content), 'sanitized');
            assert.equal(docs.files.getMetadata(relPath).source.url, ARTICLE_URL);
        });

        it('setYoutubeSource on a missing file rejects', async () => {
            await assert.rejects(() => docs.setYoutubeSource(path.join(TEST_ROOT, 'nope.youtube'), 'https://youtu.be/dQw4w9WgXcQ'), /not found/i);
        });
    });
});
