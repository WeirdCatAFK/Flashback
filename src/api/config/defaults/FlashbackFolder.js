import { LATEST_VERSION } from '../updates/registry.js';

export default function newMetadata() {
    return {
        "formatVersion": LATEST_VERSION,
        "globalHash": "",
        "tags": [],
        "excludedTags": [],
    }
}
