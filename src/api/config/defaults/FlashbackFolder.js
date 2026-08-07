import { LATEST_VERSION } from '../updates/registry.js';

// See FlashbackFile.js — folder sidecars carry the same canonical version stamp, so an
// update that ever needs to touch folder metadata has the same guarantees to work with.
export default function newMetadata() {
    return {
        "formatVersion": LATEST_VERSION,
        "globalHash": "",
        "tags": [],
        "excludedTags": [],
    }
}
