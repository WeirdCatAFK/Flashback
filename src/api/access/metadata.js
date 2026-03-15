/**
 * Metadata.js
 * Specialized service for sidecar (.flashback) files.
 */

import path from 'path';
import fs from 'fs';
import Files from './files.js';

class MetadataService {
    constructor() {
        this.files = new Files();
    }

    /**
     * Returns the absolute path of the metadata sidecar for a given relative path.
     */
    getSidecarPath(relativePath, isFolder = false) {
        const absPath = this.files.safePath(relativePath);
        return isFolder 
            ? path.join(absPath, '.flashback') 
            : absPath + '.flashback';
    }

    /**
     * Reads and parses metadata from disk.
     */
    getMetadata(relativePath, isFolder = false) {
        const sidecar = this.getSidecarPath(relativePath, isFolder);
        if (fs.existsSync(sidecar)) {
            try {
                return JSON.parse(fs.readFileSync(sidecar, 'utf-8'));
            } catch (err) {
                console.error(`Failed to parse metadata at ${sidecar}:`, err);
                return null;
            }
        }
        return null;
    }

    /**
     * Writes metadata to disk.
     */
    writeMetadata(relativePath, metadata, isFolder = false) {
        const sidecar = this.getSidecarPath(relativePath, isFolder);
        try {
            fs.writeFileSync(sidecar, JSON.stringify(metadata, null, 2));
            return true;
        } catch (err) {
            console.error(`Failed to write metadata to ${sidecar}:`, err);
            return false;
        }
    }

    /**
     * Deletes the metadata sidecar.
     */
    deleteMetadata(relativePath, isFolder = false) {
        const sidecar = this.getSidecarPath(relativePath, isFolder);
        if (fs.existsSync(sidecar)) {
            fs.unlinkSync(sidecar);
        }
    }
}

export default new MetadataService();
