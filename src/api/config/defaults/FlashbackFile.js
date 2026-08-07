import { LATEST_VERSION } from '../updates/registry.js';

// `formatVersion` is the canonical layer's equivalent of SchemaVersion, stamped per file:
// it says which canonical updates this sidecar has been through, so a file restored from a
// backup or an old Seal commit is self-describing. See config/updates/UPDATES.md.
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
