import { lazy } from 'react';

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

export function rendererFor(path) {
    if (!path) return PLACEHOLDER;
    const ext = path.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
    return BY_EXTENSION.get(ext) ?? PLACEHOLDER;
}

export { RENDERERS };
