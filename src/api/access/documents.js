/* Orchestrator file that makes all the necessary calls to the database and file system Ensuring that both canonical and derived data are updated
Methods are operations that are normally reflected on file explorers, specifically for the flasback data model which manages a tree-like structure
knowledge representation graph.
*/

import { get as config } from './config';
import files from './files';
import db from './database';

export default class Documents {
    constructor() {
        this.config = config();
        this.db = db;
        this.files = files;
    }

    // ---------- HELPERS ----------
    rebuild() {
        // Reads the canonical system to rebuild the database (most complex operation, will do later)
    }

    exists(name, relativePath = "") {

    }

    // ---------- File operations ----------

    createFile(name, relativePath = "", overwrite = false) {
        const globalHash = null;
        try {
            const absolutePath = this.files.safePath(relativePath);
            const folderPath = path.dirname(absolutePath);
            // Canonical
            try {
                //The createFile method returns the global hash
                globalHash = this.files.createFile(relativePath, name, overwrite);
            } catch (error) {
                console.error("Error creating file on canonical file system:", error);
            }

            // Derived
            try {
                // Get node type
                const type = db.prepare(
                    `SELECT id FROM NodeTypes WHERE name = 'Document'`
                ).get();

                if (!type) throw new Error("Document node type missing.");

                // Create document node
                const nodeStmt = db.prepare(`INSERT INTO Nodes (type_id) VALUES (?)`);
                const nodeInfo = nodeStmt.run(type.id);
                const nodeId = nodeInfo.lastInsertRowid;

                // Find folder
                let folderId = null;
                if (folderPath) {
                    const folder = db.prepare(
                        `SELECT id FROM Folders WHERE absolute_path = ?`
                    ).get(folderPath);

                    if (folder) folderId = folder.id;
                }
                // Insert document
                const docStmt = db.prepare(`
                    INSERT INTO Documents 
                    (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                    VALUES (?, ?, ?, ?, ?, ?, NULL)
                    `);
                const docInfo = docStmt.run(
                    folderId,
                    nodeId,
                    globalHash,
                    relativePath,
                    absolutePath,
                    name
                );
                if (!docInfo.changes) throw new Error("Document creation failed.");
            } catch (error) {
                console.error("Error creating Document on derived file system:", error);
            }
        } catch (error) {
            console.error("Error creating Document:", error);
        }
        console.log("Document created successfully with global hash:", globalHash, "and node id:", nodeId);
    }

    createFoder(name, relative_path = "", overwrite = false) {

    }

    rename() {

    }

    move() {

    }

    delete() {

    }

    copy() {

    }

    updateFile() {

    }

    updateMetadata() {

    }



}   