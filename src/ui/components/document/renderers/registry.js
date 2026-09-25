/**
 * The renderer registry: which component renders which extension, lazily for the
 * heavy ones, and each renderer's capabilities read as data by DocumentEditor
 * (editable, highlights, progress).
 */

import { lazy } from 'react';

/**
 * Which renderer opens which file, and what that renderer can do.
 *
 * Two jobs in one table, and they have to be in one table because of *when* each answer
 * is needed. The component itself is only needed once the document is on screen, so the
 * three heavy renderers are `lazy()` — pdf.js, epub.js and TipTap are ~1 MB between them,
 * and statically importing all of them meant opening *any* document paid for *every*
 * format. Their capabilities are needed **before** that: `editable` decides whether the
 * tab bar draws a Save button and `supportsHighlight` decides whether the selection
 * toolbar offers to highlight, and both render outside the Suspense boundary.
 *
 * So the flags are declared here as plain data rather than as statics on the component
 * (`MyRenderer.supportsHighlight = true`), which a lazy component cannot expose until its
 * chunk has arrived. One entry per format is also the whole "add a format" story — the
 * routing and the capability answer can no longer disagree, which two tables would allow.
 *
 * `editable` means the body is user-editable (a Save button, `PUT /api/documents/file`).
 * `supportsHighlight` means the renderer supplies a highlight command object on
 * `highlightRef`. `tracksProgress` means it reports a reading position through
 * `onProgress`, resumes from `initialProgress`, and supplies `goToStart` /
 * `currentPosition` on `progressRef` — which is what lets the editor draw the reading
 * bar before the renderer's chunk has even arrived.
 *
 * `marginCards` means the renderer draws its highlights as `[data-hl]` elements in the
 * editor's scroller, so the margin can find each passage and set its cards beside it.
 *
 * `hostsHead` means the renderer scrolls itself and mounts the document head (the `head`
 * prop) inside its own scroller, instead of the editor placing it above. Only EPUB: epub.js
 * scrolls either its own container or the window, never an ancestor, so the head has to go
 * into the book's scroller to scroll away with the book.

 */
const RENDERERS = {
    markdown: {
        load: lazy(() => import('./markdown/MarkdownRenderer')),
        extensions: ['md', 'markdown'],
        editable: true,
        supportsHighlight: true,
        tracksProgress: true,
        marginCards: true,
    },
    text: {
        load: lazy(() => import('./text/TextRenderer')),
        extensions: ['txt', 'text'],
        editable: true,
        supportsHighlight: true,
        tracksProgress: true,
        marginCards: true,
    },
    pdf: {
        load: lazy(() => import('./pdf/PdfRenderer')),
        extensions: ['pdf'],
        editable: false,
        supportsHighlight: true,
        tracksProgress: true,
        marginCards: true,
    },
    epub: {
        load: lazy(() => import('./epub/EpubRenderer')),
        extensions: ['epub'],
        editable: false,
        supportsHighlight: true,
        tracksProgress: true,
        hostsHead: true,
        marginCards: true,
    },
    youtube: {
        load: lazy(() => import('./youtube/YoutubeRenderer')),
        extensions: ['youtube'],
        editable: false,
        supportsHighlight: true,
        tracksProgress: true,
        marginCards: true,
    },
    clip: {
        load: lazy(() => import('./clip/ClipRenderer')),
        extensions: ['clip'],
        editable: false,
        supportsHighlight: true,
        tracksProgress: true,
        marginCards: true,
    },
};

/**
 * The fallback for a format nothing above claims: it renders "no preview available" and
 * is deliberately NOT lazy. It is a few lines, it is what an unknown extension lands on,
 * and a Suspense fallback flashing before a "cannot preview" message is worse than the
 * message itself.
 */
import PlaceholderRenderer from './PlaceholderRenderer';

const PLACEHOLDER = {
    load: PlaceholderRenderer,
    extensions: [],
    editable: false,
    supportsHighlight: false,
    tracksProgress: false,
};

const BY_EXTENSION = new Map();
for (const entry of Object.values(RENDERERS)) {
    for (const ext of entry.extensions) BY_EXTENSION.set(ext, entry);
}

/**
 * Resolves a workspace path to its renderer entry. Never null — an unrecognised
 * extension gets the placeholder, so callers never branch on "no renderer".
 *
 * @param {string} path
 * @returns {{ load: React.ComponentType, editable: boolean, supportsHighlight: boolean,
 *   tracksProgress: boolean, marginCards?: boolean, hostsHead?: boolean }}
 */
export function rendererFor(path) {
    if (!path) return PLACEHOLDER;
    const ext = path.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
    return BY_EXTENSION.get(ext) ?? PLACEHOLDER;
}

export { RENDERERS };
