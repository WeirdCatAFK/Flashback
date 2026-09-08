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
 * MEDIA is the one thing here that is not prose. A textbook's figure is content a
 * card wants, and there is no text form of a diagram, so `media()` lists what a
 * document carries and `mediaBuffer()` fetches one asset's bytes. Two formats carry
 * media, for opposite reasons: an EPUB's figures are sealed inside its zip
 * (`images()`/`imageBuffer()`, which `media()` delegates to), while a saved clip's
 * pictures and short sound become ordinary files in `media/` once someone saves one
 * — so a clip entry can report a real `path` and a book entry never can.
 *
 * The split is deliberate: listing is metadata only (href, alt, caption, which
 * section or heading, byte size) and rides the extraction cache; BYTES ARE NEVER
 * CACHED and come out one at a time, because a single full-page plate would swamp a
 * cache budget meant for text. Both readers work off an allow-list — an entry the
 * document itself declares — rather than path arithmetic, which is what keeps this
 * from becoming "read any entry in any zip" or "read any file in the vault". A clip
 * asset still loading from the web is refused rather than fetched: this module does
 * no network IO, and downloading one is documents.saveClipAsset's job.
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
import Files from "../resources/files.js";

export const MAX_CHARS = 20000;
const MAX_UNITS = 10;
const YT_BLOCK_CHARS = 500;
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

const IMAGE_TYPE = /^image\//i;

const MEDIA_TYPES = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg",
    oga: "audio/ogg", wav: "audio/wav", weba: "audio/webm", flac: "audio/flac",
};
const mediaTypeOf = (name) =>
    MEDIA_TYPES[path.extname(String(name ?? "")).slice(1).toLowerCase()] ?? null;

const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "TABLE", "TR", "HR", "HEADER", "FOOTER",
]);

const fail = (message, status) => Object.assign(new Error(message), { status });

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
        /** Multiplies this matrix by another, in place. */
        multiplySelf(o) {
            const a = this.a * o.a + this.c * o.b, b = this.b * o.a + this.d * o.b;
            const c = this.a * o.c + this.c * o.d, d = this.b * o.c + this.d * o.d;
            const e = this.a * o.e + this.c * o.f + this.e, f = this.b * o.e + this.d * o.f + this.f;
            this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
            return this;
        }
        /** Returns the product of this matrix and another. */
        multiply(o) { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o); }
        /** Translates this matrix in place. */
        translateSelf(tx = 0, ty = 0) { this.e += this.a * tx + this.c * ty; this.f += this.b * tx + this.d * ty; return this; }
        /** Scales this matrix in place. */
        scaleSelf(sx = 1, sy = sx) { this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy; return this; }
        /** True when this matrix is the identity. */
        get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
        /** Returns the inverse of this matrix. */
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

/** Resolves an image reference against the section that holds it, to the path the zip actually stores it under. */
function resolveHref(baseHref, src) {
    const clean = String(src ?? "").split("#")[0].split("?")[0].trim();
    if (!clean) return null;
    let decoded;
    try { decoded = decodeURIComponent(clean); } catch { decoded = clean; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
    return path.posix.normalize(
        decoded.startsWith("/") ? decoded.slice(1) : `${path.posix.dirname(baseHref)}/${decoded}`,
    );
}

/** Every image a section paints, in document order, with the alt text and caption that identify it without looking at it. */
function sectionImages(doc, sectionHref) {
    const out = [];
    for (const el of doc.querySelectorAll("img, image")) {
        const href = resolveHref(
            sectionHref,
            el.getAttribute("src") ?? el.getAttribute("xlink:href") ?? el.getAttribute("href"),
        );
        if (!href) continue;
        const caption = el.closest?.("figure")?.querySelector("figcaption")?.textContent;
        out.push({
            href,
            alt: el.getAttribute("alt")?.trim() || null,
            caption: caption?.trim() || null,
        });
    }
    return out;
}

/** Node.DOCUMENT_POSITION_FOLLOWING — the argument comes after the receiver. */
const DOCUMENT_POSITION_FOLLOWING = 4;

/** The heading a clip element sits under: the last h1–h6 that precedes it in document order, or null above the first one. */
function headingBefore(headings, el) {
    let found = null;
    for (const h of headings) {
        if (!(h.compareDocumentPosition(el) & DOCUMENT_POSITION_FOLLOWING)) break;
        found = h;
    }
    const label = found ? tidy(found.textContent ?? "") : "";
    return label ? label.slice(0, 120) : null;
}

/** Whether a link points at a sound a browser can play, and is therefore a sound the clip carries rather than an ordinary link. */
const PLAYABLE_SOUND_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)(\?|#|$)/i;
function isSoundLink(href) {
    if (!href) return false;
    const segment = href.split("?")[0].split("#")[0].split("/").pop() || "";
    if (segment.includes(":")) return false;
    return PLAYABLE_SOUND_EXT.test(segment);
}

/** Every picture and sound a saved clip carries, in document order. */
function clipMedia(doc) {
    const headings = [...doc.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    const out = [];
    for (const el of doc.querySelectorAll("img, audio, a[href]")) {
        const tag = (el.tagName ?? "").toUpperCase();
        const isLink = tag === "A";
        if (isLink && !isSoundLink(el.getAttribute("href"))) continue;
        const isAudio = tag === "AUDIO" || isLink;
        const src = (
            (isLink ? el.getAttribute("href") : el.getAttribute("src"))
            || (isAudio && !isLink ? el.querySelector("source")?.getAttribute("src") : null)
            || ""
        ).trim();
        if (!src) continue;

        const cachedName = src.match(/^\.?\/?media\/(.+)$/)?.[1];
        let name = cachedName;
        if (name) {
            try { name = decodeURIComponent(name); } catch { }
        } else {
            name = src.split("?")[0].split("#")[0].split("/").pop() || src;
        }
        const caption = el.closest?.("figure")?.querySelector("figcaption")?.textContent;

        out.push({
            index: out.length + 1,
            kind: isAudio ? "audio" : "image",
            href: src,
            name,
            mediaType: mediaTypeOf(name),
            bytes: null,
            alt: isLink ? null : (el.getAttribute("alt")?.trim() || el.getAttribute("title")?.trim() || null),
            caption: caption?.trim() || null,
            heading: headingBefore(headings, el),
            cached: Boolean(cachedName),
        });
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

/** Groups transcript cues into readable blocks of ~`YT_BLOCK_CHARS`, each labelled with its start timestamp. */
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
        .replace(/[ \t\u00a0]+/g, " ")
        .split("\n").map((l) => l.trim()).join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

class McpReader {
    constructor() {
        this.files = new Files();
        this._cache = new Map();
    }

    /** Drops the extraction cache on a vault switch. */
    onVaultOpened() {
        this._cache.clear();
    }

    /** The document's format id, or null when the extension is not a known one. */
    _formatOf(relPath) {
        return FORMATS[path.extname(relPath).toLowerCase()] ?? null;
    }

    _cacheKey(relPath) {
        const { size, mtimeMs } = this.files.statFile(relPath);
        return `${path.normalize(relPath)}|${mtimeMs}|${size}`;
    }

    _cacheGet(key) {
        const hit = this._cache.get(key);
        if (!hit) return null;
        this._cache.delete(key);
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

    /** Extracts a document into `{ format, unit, segments: [{label, text}] }`. */
    async _extract(relPath) {
        if (!await this.files.exists(relPath)) throw fail(`Document ${relPath} not found`, 404);
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

    async _extractClip(relPath) {
        const { content } = this.files.readFile(relPath);
        const { JSDOM } = await import("jsdom");
        const body = new JSDOM(`<body>${content ?? ""}</body>`).window.document.body;
        return {
            format: "clip", unit: "chars",
            segments: [{ label: null, text: tidy(blockText(body)) }],
            media: clipMedia(body),
        };
    }

    _extractYoutube(relPath) {
        const { content } = this.files.readFile(relPath);
        let d = {};
        try { d = JSON.parse(content ?? "{}"); } catch { }

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

    async _extractPdf(relPath) {
        ensurePdfGlobals();
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const require = createRequire(import.meta.url);
        const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
        const fontsDir = path.join(pdfjsDir, "standard_fonts") + path.sep;

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
            verbosity: 0,
        });

        let pdf;
        try {
            pdf = await task.promise;
            const segments = [];
            for (let n = 1; n <= pdf.numPages; n++) {
                const page = await pdf.getPage(n);
                const tc = await page.getTextContent();
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
                properties: item.getAttribute("properties") ?? "",
            });
        }

        const coverId = [...opfDoc.querySelectorAll("meta")]
            .find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");

        const images = new Map();
        for (const [id, item] of manifest) {
            if (!item.href || !IMAGE_TYPE.test(item.type)) continue;
            const href = resolve(decodeURIComponent(item.href));
            images.set(href, {
                href,
                name: path.posix.basename(href),
                mediaType: item.type,
                bytes: zip.getEntry(href)?.header?.size ?? 0,
                alt: null,
                caption: null,
                section: null,
                sectionIndex: null,
                isCover: /\bcover-image\b/.test(item.properties) || (coverId != null && coverId === id),
            });
        }
        const imageOrder = [];

        const segments = [];
        for (const ref of opfDoc.querySelectorAll("spine > itemref")) {
            const item = manifest.get(ref.getAttribute("idref"));
            if (!item?.href || !/x?html/i.test(item.type)) continue;
            const href = resolve(decodeURIComponent(item.href));
            const raw = entryText(href);
            if (raw == null) continue;
            const doc = new JSDOM(raw).window.document;
            const text = tidy(blockText(doc.body ?? doc.documentElement));
            const title = doc.querySelector("title")?.textContent?.trim()
                || doc.querySelector("h1, h2")?.textContent?.trim();
            const label = title || path.posix.basename(href);

            for (const found of sectionImages(doc, href)) {
                const entry = images.get(found.href);
                if (!entry) continue;
                if (!imageOrder.includes(found.href)) imageOrder.push(found.href);
                entry.alt ??= found.alt;
                entry.caption ??= found.caption;
                entry.section ??= label;
                if (text && entry.sectionIndex == null) entry.sectionIndex = segments.length + 1;
            }

            if (!text) continue;
            segments.push({ label, href, text });
        }

        if (segments.length === 0) throw fail(`${relPath} has no readable sections.`, 415);

        for (const href of images.keys()) {
            if (!imageOrder.includes(href)) imageOrder.push(href);
        }
        const ordered = imageOrder.map((href, i) => ({ index: i + 1, ...images.get(href) }));

        return { format: "epub", unit: "section", segments, images: ordered };
    }

    /** What this document is and how much of it there is, without extracting a body the caller may not want. */
    async info(relPath) {
        const doc = await this._extract(relPath);
        const total = doc.unit === "chars" ? doc.segments[0].text.length : doc.segments.length;
        return {
            path: relPath,
            format: doc.format,
            unit: doc.unit,
            total,
            extractable: total > 0,
            note: total === 0
                ? "No text layer — this document is probably scanned images, and would need OCR to read."
                : (doc.format === "youtube" && doc.unit === "segment")
                    ? "Transcript segments carry timestamp labels; pass at=<seconds> to jump to a moment (e.g. a video_timestamp highlight's start)."
                    : undefined,
            sections: doc.unit === "section"
                ? doc.segments.map((s, i) => ({ index: i + 1, label: s.label, href: s.href, chars: s.text.length }))
                : undefined,
            images: doc.images ? doc.images.length : undefined,
            media: doc.media
                ? {
                    total: doc.media.length,
                    images: doc.media.filter((m) => m.kind === "image").length,
                    audio: doc.media.filter((m) => m.kind === "audio").length,
                }
                : undefined,
        };
    }

    /** The images an EPUB declares, in reading order. */
    async images(relPath) {
        const doc = await this._extract(relPath);
        if (!doc.images) {
            throw fail(
                `${relPath} is a ${doc.format} document — only EPUBs carry extractable images.`,
                415,
            );
        }
        return { path: relPath, format: doc.format, total: doc.images.length, images: doc.images };
    }

    /** One image's bytes, addressed by an `href` (or bare file name) from images(). */
    async imageBuffer(relPath, href) {
        const { images } = await this.images(relPath);

        const wanted = String(href ?? "").trim().replace(/^\.?\//, "");
        const exact = images.find((i) => i.href === wanted);
        const found = exact
            ? [exact]
            : images.filter((i) => i.name === wanted || i.href.endsWith(`/${wanted}`));

        if (found.length === 0) {
            throw fail(`No image "${href}" in ${relPath}. Call images for the list.`, 400);
        }
        if (found.length > 1) {
            throw fail(
                `"${href}" matches ${found.length} images in ${relPath} `
                + `(${found.map((f) => f.href).join(", ")}). Use the full href from images.`,
                400,
            );
        }
        const entry = found[0];

        const { default: AdmZip } = await import("adm-zip");
        const data = new AdmZip(this.files.readBuffer(relPath)).getEntry(entry.href)?.getData();
        if (!data?.length) {
            throw fail(`${entry.href} is in ${relPath}'s manifest but missing from the archive.`, 404);
        }
        return { buffer: data, mediaType: entry.mediaType, name: entry.name, bytes: data.length };
    }

    /** The media a document carries, whatever kind of document it is: an EPUB's figures or a clip's pictures and sound. */
    async media(relPath) {
        const doc = await this._extract(relPath);

        if (doc.images) {
            const { images } = await this.images(relPath);
            return {
                path: relPath,
                format: doc.format,
                total: images.length,
                media: images.map((i) => ({ kind: "image", cached: true, path: null, ...i })),
            };
        }

        if (doc.media) {
            const media = doc.media.map((m) => {
                if (!m.cached) return { ...m, path: null };
                const rel = path.join(path.dirname(relPath), "media", m.name);
                let bytes = null;
                try { bytes = this.files.statFile(rel).size; } catch { }
                return { ...m, path: rel, bytes };
            });
            return { path: relPath, format: doc.format, total: media.length, media };
        }

        throw fail(
            `${relPath} is a ${doc.format} document — only EPUBs and saved web clips carry extractable media.`,
            415,
        );
    }

    /** One asset's bytes, addressed by an `href` (or bare file name) from media(). */
    async mediaBuffer(relPath, href) {
        const doc = await this._extract(relPath);
        if (doc.images) return { ...(await this.imageBuffer(relPath, href)), kind: "image" };

        const { media } = await this.media(relPath);
        const wanted = String(href ?? "").trim().replace(/^\.?\//, "");
        const exact = media.find((m) => m.href === href || m.href.replace(/^\.?\//, "") === wanted);
        const found = exact ? [exact] : media.filter((m) => m.name === wanted);

        if (found.length === 0) {
            throw fail(`No media "${href}" in ${relPath}. Call media for the list.`, 400);
        }
        if (found.length > 1) {
            throw fail(
                `"${href}" matches ${found.length} assets in ${relPath} `
                + `(${found.map((f) => f.href).join(", ")}). Use the full href from media.`,
                400,
            );
        }
        const entry = found[0];

        if (!entry.cached) {
            throw fail(
                `"${entry.name}" is not in the vault — it is still served from ${entry.href}, and `
                + `nothing here will fetch it for you. Save it into the clip first `
                + `(POST /api/documents/clip/asset), or go by its alt text and caption.`,
                400,
            );
        }

        const buffer = this.files.readBuffer(entry.path);
        if (!buffer?.length) {
            throw fail(`${entry.path} is referenced by ${relPath} but missing from the vault.`, 404);
        }
        return {
            buffer,
            mediaType: entry.mediaType || "application/octet-stream",
            name: entry.name,
            bytes: buffer.length,
            kind: entry.kind,
        };
    }

    /**
     * A window of the document's text.
     *
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

        let start;
        const hasTimestamps = doc.segments.some((s) => typeof s.start === "number");
        if (at != null && at !== "" && !Number.isNaN(Number(at)) && hasTimestamps) {
            const sec = Number(at);
            let covering = 0;
            for (let i = 0; i < total; i++) {
                if ((doc.segments[i].start ?? 0) <= sec) covering = i; else break;
            }
            start = covering + 1;
        } else if (typeof index === "string" && !/^\d+$/.test(index)) {
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
        let truncated = false;
        let next = null;
        let nextCharOffset = 0;

        for (let i = start; i <= lastWanted; i++) {
            const seg = doc.segments[i - 1];
            const from = i === start ? Math.min(skip, seg.text.length) : 0;
            const header = `${text ? "\n\n" : ""}[${seg.label}]\n`;
            const room = MAX_CHARS - text.length - header.length;

            if (room <= 0) { next = i; break; }

            const body = seg.text.slice(from, from + room);
            text += header + body;

            if (from + body.length < seg.text.length) {
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
            next,
            nextCharOffset,
            truncated,
        };
    }
}

export default new McpReader();
