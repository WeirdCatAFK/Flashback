import { LATEST_VERSION } from '../updates/registry.js';

/** A fresh default sidecar. */
export default function newMetadata() {
    return {
        "formatVersion": LATEST_VERSION,
        "globalHash": "",
        "tags": [],
        "excludedTags": [],
        "flashcards": [],
        "highlights": [],
        "links": [],
        "encoding": "UTF-8"
    };
}
