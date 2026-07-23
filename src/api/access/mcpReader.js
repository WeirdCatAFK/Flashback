/**
 * mcpReader.js — read-only text extraction for documents whose bodies the app can
 * render but not decode as text (PDF, EPUB, web clips).
 *
 * Why this is its own module and not part of documents.js: the methods there
 * (`importFile`, `updateFile`, `_buildClipDoc`) exist to serve the app's own
 * multipart-upload → render flow, and they write. This is the opposite — a
 * read-only, format-aware reader whose consumer is the MCP server, which has no
 * renderer and cannot receive bytes. `files.readFile` deliberately refuses to
 * decode binaries (decoding a PDF through iconv yields mojibake); this module is
 * the sanctioned way to get *actual prose* out of one.
 *
 * What it deliberately does NOT do: produce highlight anchors. A highlight has to
 * land in the coordinate system its renderer paints from — bbox geometry from the
 * PDF text layer, an epub.js CFI generated from the live iframe DOM — and neither
 * can be computed faithfully server-side. Cards don't need one (create_flashcard's
 * highlightHash is optional), so the assistant can read a book and draft cards from
 * it; anchoring stays a reading gesture the user makes in the app.
 *
 * Addressing is by each format's NATIVE unit, because that is how these documents
 * are actually referenced: PDFs by page, EPUBs by spine section, text by character
 * window. `index` is 1-based for pages and sections, and every response carries a
 * human `label` ("p. 37", a chapter title) so a card drafted from a chunk can cite
 * where it came from.
 *
 * Tier 3 orchestrator, but a narrow one: it imports `files.js` and nothing else —
 * no database, no query.js, no documents.js. Read-only toward the canonical layer
 * (like doctor.js). Heavy parsers (pdfjs-dist, adm-zip, jsdom) are lazily imported
 * on first use, following the `documents._buildClipDoc` precedent, so API startup
 * pays nothing for a vault that holds no PDFs.
 */

import path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import Files from "./files.js";

// Per-response ceiling. A response is a tool result that lands in a model's context;
// a 40-page chapter arriving whole helps nobody.
export const MAX_CHARS = 20000;
// Pages/sections per call, so walking a book doesn't cost one round trip per page.
const MAX_UNITS = 10;
// Transcript cues are tiny (a few words each); merge consecutive ones into readable
// blocks of about this many characters, each keeping its start timestamp.
const YT_BLOCK_CHARS = 500;
// Extraction is expensive (a 300-page PDF is seconds); paginated reading hits the
// same file repeatedly. Cache the extracted segments, never the raw file.
const CACHE_ENTRIES = 4;
const CACHE_CHARS = 4_000_000;

const FORMATS = {
    ".md": "markdown", ".markdown": "markdown",
    ".txt": "text", ".text": "text",
    ".pdf": "pdf",
    ".epub": "epub",
    ".clip": "clip",
    ".youtube": "youtube",
};

// Tags whose content reads as its own block of prose — used to keep paragraph
// breaks when flattening XHTML/HTML, which textContent alone throws away.
const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "TABLE", "TR", "HR", "HEADER", "FOOTER",
]);

const fail = (message, status) => Object.assign(new Error(message), { status });

// pdfjs reaches for a handful of browser globals during transform math, even when
// only reading the text layer (no canvas, no rendering). The API runs in Node —
// Electron's utility process for the packaged app, plain Node for dev/tests — none
// of which define DOMMatrix, so a real PDF fails at getDocument() with
// "DOMMatrix is not defined". This is a minimal implementation of exactly the ops
// pdfjs uses for text extraction (verified against real multi-hundred-page PDFs,
// including CJK); it is NOT a general-purpose or spec-complete DOMMatrix, and it is
// installed once, lazily, only when the first PDF is read. Avoids a native `canvas`
// dependency for a text-only feature.
let _pdfGlobalsReady = false;
function ensurePdfGlobals() {
    if (_pdfGlobalsReady) return;
    _pdfGlobalsReady = true;
    if (typeof globalThis.DOMMatrix !== "undefined") return;

    class DOMMatrix {
        constructor(init) {
            this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
            if (Array.isArray(init) && init.length >= 6) {
                [this.a, this.b, this.c, this.d, this.e, this.f] = init;
            } else if (typeof init === "string") {
                const m = init.match(/matrix\(([^)]+)\)/);
                if (m) [this.a, this.b, this.c, this.d, this.e, this.f] = m[1].split(",").map(Number);
            }
        }
        multiplySelf(o) {
            const a = this.a * o.a + this.c * o.b, b = this.b * o.a + this.d * o.b;
            const c = this.a * o.c + this.c * o.d, d = this.b * o.c + this.d * o.d;
            const e = this.a * o.e + this.c * o.f + this.e, f = this.b * o.e + this.d * o.f + this.f;
            this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
            return this;
        }
        multiply(o) { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o); }
        translateSelf(tx = 0, ty = 0) { this.e += this.a * tx + this.c * ty; this.f += this.b * tx + this.d * ty; return this; }
        scaleSelf(sx = 1, sy = sx) { this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy; return this; }
        get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
        inverse() {
            const det = this.a * this.d - this.b * this.c;
            if (!det) return new DOMMatrix();
            const m = new DOMMatrix();
            m.a = this.d / det; m.b = -this.b / det; m.c = -this.c / det; m.d = this.a / det;
            m.e = (this.c * this.f - this.d * this.e) / det; m.f = (this.b * this.e - this.a * this.f) / det;
            return m;
        }
    }
    globalThis.DOMMatrix = DOMMatrix;
}

/** Flattens a DOM subtree to text, preserving block/line breaks. */
function blockText(el) {
    let out = "";
    for (const node of el.childNodes) {
        if (node.nodeType === 3) { out += node.nodeValue ?? ""; continue; }
        if (node.nodeType !== 1) continue;
        const tag = (node.tagName ?? "").toUpperCase();
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG") continue;
        if (tag === "BR") { out += "\n"; continue; }
        const inner = blockText(node);
        out += BLOCK_TAGS.has(tag) ? `\n${inner}\n` : inner;
    }
    return out;
}

/** Seconds → "m:ss" (or "h:mm:ss"), matching the YoutubeRenderer's marker labels. */
function formatTimestamp(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/**
 * Groups transcript cues `{ start, text }` into readable blocks of ~YT_BLOCK_CHARS,
 * each labelled with its start timestamp and carrying `start` (seconds) so a block
 * can be addressed by `at`.
 */
function groupCues(cues) {
    const blocks = [];
    let cur = null;
    for (const c of cues) {
        const text = String(c.text ?? "").trim();
        if (!text) continue;
        if (!cur) cur = { start: Number(c.start) || 0, parts: [] };
        cur.parts.push(text);
        if (cur.parts.join(" ").length >= YT_BLOCK_CHARS) {
            blocks.push({ label: formatTimestamp(cur.start), start: cur.start, text: cur.parts.join(" ") });
            cur = null;
        }
    }
    if (cur) blocks.push({ label: formatTimestamp(cur.start), start: cur.start, text: cur.parts.join(" ") });
    return blocks;
}

/** Collapses the whitespace soup that flattening markup produces. */
function tidy(text) {
    return text
        .replace(/\r\n?/g, "\n")
        // \u00a0 (nbsp) is everywhere in text extracted from PDFs and HTML.
        .replace(/[ \t\u00a0]+/g, " ")
        .split("\n").map((l) => l.trim()).join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

class McpReader {
    constructor() {
        this.files = new Files();
        // key -> { doc, chars }; insertion-ordered, so the oldest key is the LRU victim.
        this._cache = new Map();
    }

    /** The document's format id, or null when the extension is not a known one. */
    _formatOf(relPath) {
        return FORMATS[path.extname(relPath).toLowerCase()] ?? null;
    }

    // ---------- cache ----------

    _cacheKey(relPath) {
        const { size, mtimeMs } = this.files.statFile(relPath);
        // mtime+size means an edited or re-imported file invalidates itself.
        return `${path.normalize(relPath)}|${mtimeMs}|${size}`;
    }

    _cacheGet(key) {
        const hit = this._cache.get(key);
        if (!hit) return null;
        this._cache.delete(key);      // re-insert to mark as most recently used
        this._cache.set(key, hit);
        return hit.doc;
    }

    _cacheSet(key, doc) {
        const chars = doc.segments.reduce((a, s) => a + s.text.length, 0);
        this._cache.set(key, { doc, chars });
        let total = 0;
        for (const e of this._cache.values()) total += e.chars;
        while (this._cache.size > CACHE_ENTRIES || (total > CACHE_CHARS && this._cache.size > 1)) {
            const oldest = this._cache.keys().next().value;
            total -= this._cache.get(oldest).chars;
            this._cache.delete(oldest);
        }
    }

    // ---------- extraction ----------

    /**
     * Extracts a document into `{ format, unit, segments: [{label, text}] }`.
     * `chars`-unit formats yield exactly one segment. Cached per file version.
     */
    async _extract(relPath) {
        if (!this.files.exists(relPath)) throw fail(`Document ${relPath} not found`, 404);
        const format = this._formatOf(relPath);
        if (!format) {
            throw fail(
                `${path.extname(relPath) || "This format"} has no readable text. ` +
                `Readable formats: Markdown, plain text, PDF, EPUB, and saved web clips.`,
                415,
            );
        }

        const key = this._cacheKey(relPath);
        const cached = this._cacheGet(key);
        if (cached) return cached;

        let doc;
        switch (format) {
            case "markdown":
            case "text":    doc = this._extractPlain(relPath, format); break;
            case "clip":    doc = await this._extractClip(relPath); break;
            case "youtube": doc = this._extractYoutube(relPath); break;
            case "pdf":     doc = await this._extractPdf(relPath); break;
            case "epub":    doc = await this._extractEpub(relPath); break;
            default:        throw fail(`Unsupported format ${format}`, 415);
        }

        this._cacheSet(key, doc);
        return doc;
    }

    _extractPlain(relPath, format) {
        const { content, binary } = this.files.readFile(relPath);
        if (binary || content == null) {
            throw fail(`${relPath} claims to be text but holds binary data.`, 415);
        }
        return { format, unit: "chars", segments: [{ label: null, text: content }] };
    }

    // A .clip body is the sanitized HTML of a saved web page.
    async _extractClip(relPath) {
        const { content } = this.files.readFile(relPath);
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM(`<body>${content ?? ""}</body>`);
        return {
            format: "clip", unit: "chars",
            segments: [{ label: null, text: tidy(blockText(dom.window.document.body)) }],
        };
    }

    // A .youtube body is a small JSON descriptor; the transcript, when fetched, lives
    // in the sidecar's source block (documents.fetchYoutubeTranscript). With a
    // transcript we return timestamped segments the caller can walk or address by
    // `at`=seconds; without one, a note explaining how to make it readable.
    _extractYoutube(relPath) {
        const { content } = this.files.readFile(relPath);
        let d = {};
        try { d = JSON.parse(content ?? "{}"); } catch { /* hand-edited stub */ }

        const source = this.files.getMetadata(relPath)?.source ?? {};
        const cues = Array.isArray(source.transcript) ? source.transcript : null;
        if (cues && cues.length) {
            const segments = groupCues(cues);
            if (segments.length) return { format: "youtube", unit: "segment", segments };
        }

        const lines = [
            d.title ? `Title: ${d.title}` : null,
            d.author ? `Channel: ${d.author}` : null,
            d.url ? `URL: ${d.url}` : null,
            "",
            "This is a YouTube reference document with no transcript in the vault yet, so the " +
            "video's spoken content is not readable here and its timestamp highlights can't be " +
            "resolved to text. Run fetch_youtube_transcript (or the app's “Fetch transcript” " +
            "button) to pull the video's captions in, then read this document again.",
        ].filter((l) => l !== null);
        return { format: "youtube", unit: "chars", segments: [{ label: null, text: lines.join("\n") }] };
    }

    // pdfjs needs its legacy build in Node, with the worker and font machinery off:
    // we want the text layer, never a rendered page (no canvas involved).
    async _extractPdf(relPath) {
        ensurePdfGlobals();
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const require = createRequire(import.meta.url);
        const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
        const fontsDir = path.join(pdfjsDir, "standard_fonts") + path.sep;

        // pdfjs only skips the worker when it decides it is running under Node. That
        // check (isNodeJS) is FALSE in Electron's utility process — where the packaged
        // API actually runs — because process.type is "utility", so pdfjs takes the
        // browser path and refuses to start without a workerSrc. Point it at the
        // bundled worker: with no web Worker in the utility process, pdfjs loads that
        // module on the main thread (its fake-worker fallback), which is exactly the
        // in-process parse we want. Harmless under plain Node, where the worker is
        // skipped regardless. Set once — GlobalWorkerOptions is module-global.
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
            pdfjs.GlobalWorkerOptions.workerSrc =
                pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
        }

        const task = pdfjs.getDocument({
            data: new Uint8Array(this.files.readBuffer(relPath)),
            useWorkerFetch: false,
            isEvalSupported: false,
            useSystemFonts: false,
            disableFontFace: true,
            standardFontDataUrl: pathToFileURL(fontsDir).href,
            verbosity: 0,   // font-data warnings are irrelevant when only reading text
        });

        let pdf;
        try {
            pdf = await task.promise;
            const segments = [];
            for (let n = 1; n <= pdf.numPages; n++) {
                const page = await pdf.getPage(n);
                const tc = await page.getTextContent();
                // hasEOL marks the end of a visual line in the text layer.
                const text = tc.items.map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : "")).join("");
                page.cleanup();
                segments.push({ label: `p. ${n}`, text: tidy(text) });
            }
            return { format: "pdf", unit: "page", segments };
        } catch (err) {
            throw fail(`Could not read ${relPath} as a PDF: ${err.message}`, 415);
        } finally {
            await task.destroy().catch(() => { });
        }
    }

    // An EPUB is a zip: container.xml points at the OPF, whose spine gives reading
    // order. epub.js is not used here — it is a browser renderer; this only needs
    // the XHTML in order.
    async _extractEpub(relPath) {
        const { default: AdmZip } = await import("adm-zip");
        const { JSDOM } = await import("jsdom");

        let zip;
        try { zip = new AdmZip(this.files.readBuffer(relPath)); } catch (err) {
            throw fail(`Could not read ${relPath} as an EPUB: ${err.message}`, 415);
        }
        const entryText = (p) => zip.getEntry(p)?.getData().toString("utf-8") ?? null;
        const xml = (s) => new JSDOM(s, { contentType: "text/xml" }).window.document;

        const container = entryText("META-INF/container.xml");
        if (!container) throw fail(`${relPath} is not a valid EPUB (no META-INF/container.xml).`, 415);
        const opfPath = xml(container).querySelector("rootfile")?.getAttribute("full-path");
        if (!opfPath) throw fail(`${relPath} is not a valid EPUB (no rootfile in container.xml).`, 415);

        const opfDoc = xml(entryText(opfPath) ?? "");
        const opfDir = path.posix.dirname(opfPath.replace(/\\/g, "/"));
        const resolve = (href) => path.posix.normalize(opfDir === "." ? href : `${opfDir}/${href}`);

        const manifest = new Map();
        for (const item of opfDoc.querySelectorAll("manifest > item")) {
            manifest.set(item.getAttribute("id"), {
                href: item.getAttribute("href"),
                type: item.getAttribute("media-type") ?? "",
            });
        }

        const segments = [];
        for (const ref of opfDoc.querySelectorAll("spine > itemref")) {
            const item = manifest.get(ref.getAttribute("idref"));
            if (!item?.href || !/x?html/i.test(item.type)) continue;
            const href = resolve(decodeURIComponent(item.href));
            const raw = entryText(href);
            if (raw == null) continue;
            const doc = new JSDOM(raw).window.document;
            const text = tidy(blockText(doc.body ?? doc.documentElement));
            if (!text) continue;   // covers, blank pages
            const title = doc.querySelector("title")?.textContent?.trim()
                || doc.querySelector("h1, h2")?.textContent?.trim();
            segments.push({ label: title || path.posix.basename(href), href, text });
        }

        if (segments.length === 0) throw fail(`${relPath} has no readable sections.`, 415);
        return { format: "epub", unit: "section", segments };
    }

    // ---------- public surface ----------

    /**
     * What this document is and how much of it there is, without extracting a body
     * the caller may not want. `total` counts pages, sections, or characters
     * depending on `unit`.
     */
    async info(relPath) {
        const doc = await this._extract(relPath);
        const total = doc.unit === "chars" ? doc.segments[0].text.length : doc.segments.length;
        return {
            path: relPath,
            format: doc.format,
            unit: doc.unit,
            total,
            extractable: total > 0,
            // A scanned PDF parses fine and yields nothing: say so, rather than
            // letting the caller read empty page after empty page.
            note: total === 0
                ? "No text layer — this document is probably scanned images, and would need OCR to read."
                : (doc.format === "youtube" && doc.unit === "segment")
                    ? "Transcript segments carry timestamp labels; pass at=<seconds> to jump to a moment (e.g. a video_timestamp highlight's start)."
                    : undefined,
            sections: doc.unit === "section"
                ? doc.segments.map((s, i) => ({ index: i + 1, label: s.label, href: s.href, chars: s.text.length }))
                : undefined,
        };
    }

    /**
     * A window of the document's text.
     * @param {string} relPath
     * @param {object} [opts]
     * @param {number|string} [opts.index=1] 1-based page/section, or an EPUB spine href.
     * @param {number} [opts.count=1] pages/sections to return (capped at MAX_UNITS).
     * @param {number} [opts.offset=0] `chars` unit: where to start.
     * @param {number} [opts.limit=MAX_CHARS] `chars` unit: how much to return.
     * @param {number} [opts.charOffset=0] continue *inside* a unit larger than MAX_CHARS.
     * @param {number} [opts.at] segment units with timestamps (YouTube): seconds to jump to.
     */
    async read(relPath, opts = {}) {
        const doc = await this._extract(relPath);
        return doc.unit === "chars" ? this._readChars(relPath, doc, opts) : this._readUnits(relPath, doc, opts);
    }

    _readChars(relPath, doc, { offset = 0, limit = MAX_CHARS }) {
        const full = doc.segments[0].text;
        const start = Math.max(0, Math.trunc(Number(offset) || 0));
        const size = Math.min(Math.max(1, Math.trunc(Number(limit) || MAX_CHARS)), MAX_CHARS);
        if (start >= full.length && full.length > 0) {
            throw fail(`offset ${start} is past the end of ${relPath} (${full.length} characters).`, 400);
        }
        const end = Math.min(full.length, start + size);
        return {
            path: relPath, format: doc.format, unit: "chars",
            index: start, total: full.length, label: null,
            text: full.slice(start, end),
            hasMore: end < full.length,
            next: end < full.length ? end : null,
            truncated: false,
        };
    }

    _readUnits(relPath, doc, { index = 1, count = 1, charOffset = 0, at }) {
        const total = doc.segments.length;

        // Timestamped segments (YouTube transcript): `at`=seconds lands on the block
        // covering that moment, so a video_timestamp highlight resolves straight to
        // its passage. Pass `count` for surrounding context.
        let start;
        const hasTimestamps = doc.segments.some((s) => typeof s.start === "number");
        if (at != null && at !== "" && !Number.isNaN(Number(at)) && hasTimestamps) {
            const sec = Number(at);
            let covering = 0;
            for (let i = 0; i < total; i++) {
                if ((doc.segments[i].start ?? 0) <= sec) covering = i; else break;
            }
            start = covering + 1;   // 1-based block covering that timestamp
        } else if (typeof index === "string" && !/^\d+$/.test(index)) {
            // EPUB sections can be addressed by spine href, so a caller can follow a
            // table of contents it has already seen instead of counting.
            const found = doc.segments.findIndex((s) => s.href === index || path.posix.basename(s.href ?? "") === index);
            if (found === -1) throw fail(`No section "${index}" in ${relPath}. Call info for the section list.`, 400);
            start = found + 1;
        } else {
            start = Math.trunc(Number(index) || 1);
        }
        if (start < 1 || start > total) {
            throw fail(`${doc.unit} ${start} is out of range for ${relPath} (1–${total}).`, 400);
        }

        const want = Math.min(Math.max(1, Math.trunc(Number(count) || 1)), MAX_UNITS);
        const skip = Math.max(0, Math.trunc(Number(charOffset) || 0));
        const lastWanted = Math.min(start + want - 1, total);

        let text = "";
        let truncated = false;      // a unit was cut mid-way
        let next = null;            // where a follow-up read should resume
        let nextCharOffset = 0;

        for (let i = start; i <= lastWanted; i++) {
            const seg = doc.segments[i - 1];
            const from = i === start ? Math.min(skip, seg.text.length) : 0;
            // Each unit is labelled inline so a multi-unit read stays attributable.
            const header = `${text ? "\n\n" : ""}[${seg.label}]\n`;
            const room = MAX_CHARS - text.length - header.length;

            if (room <= 0) { next = i; break; }          // stop before this unit; none of it fit

            const body = seg.text.slice(from, from + room);
            text += header + body;

            if (from + body.length < seg.text.length) {   // this unit was cut
                truncated = true;
                next = i;
                nextCharOffset = from + body.length;
                break;
            }
            if (i === lastWanted && i < total) next = i + 1;
        }

        return {
            path: relPath, format: doc.format, unit: doc.unit,
            index: start, total,
            label: doc.segments[start - 1].label,
            text,
            hasMore: next !== null,
            // Resume mid-unit when one overflowed, otherwise at the next unit.
            next,
            nextCharOffset,
            truncated,
        };
    }
}

export default new McpReader();
