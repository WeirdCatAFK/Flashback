import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import AdmZip from 'adm-zip';
import db from '../src/api/access/database.js';
import Subscriptions from '../src/api/access/subscriptions.js';
import validate from '../src/api/config/validate.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

console.log(`
--------------------------------------------------
  Running Subscriptions Integration Tests
  USER_DATA_PATH: ${process.env.USER_DATA_PATH}
--------------------------------------------------
`);

const subscriptions = new Subscriptions();
const TEST_ROOT = "SubscriptionTest";
const MAGAZINE_ID = "test-magazine-123";
const doc1Hash = "a1b9b418-e67c-446c-9a4a-2e6988c5a2df";
const doc2Hash = "b2c8c324-d56b-335b-8a3b-1d5877b4a1de";
const fc1Hash = "c3d7d230-c45a-224a-7a2a-0c4766a3b0cd";
const fc2Hash = "d4e6e136-b349-1139-6a19-fb365592cfae";


describe('Subscriptions Integration Tests', () => {

    const cleanup = async () => {
        try {
            // Clear Database Tables
            const dropAll = db.transaction(() => {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").all();
                for (const table of tables) {
                    db.prepare(`DROP TABLE IF EXISTS "${table.name}"`).run();
                }
            });
            
            db.pragma('foreign_keys = OFF');
            dropAll();
            db.pragma('foreign_keys = ON');

            // Re-initialize DB
            if (!validate()) {
                throw new Error("Validation failed during cleanup");
            }

            // Clear Workspace Folder
            const absRoot = path.join(process.env.USER_DATA_PATH, 'workspace', TEST_ROOT);
            if (fsSync.existsSync(absRoot)) {
                await fs.rm(absRoot, { recursive: true, force: true });
            }
            await subscriptions.documents.createFolder(TEST_ROOT);
            
        } catch (e) {
            console.error("Cleanup error:", e);
        }
    };

    before(async () => {
        if (!validate()) {
            console.error("Validation failed. May be an initialization issue.");
            process.exit(1);
        }
        await cleanup();
    });

    const createIssueZip = (issueId, version, content) => {
        const zip = new AdmZip();
        const issueFolderName = `${MAGAZINE_ID}-${version}`;
        
        const rootFlashback = {
            globalHash: "magazine-root-hash",
            tags: ["Test Magazine"],
            subscription: {
                magazineId: MAGAZINE_ID,
                issueId: issueId,
                version: version,
            }
        };
        zip.addFile(`${issueFolderName}/.flashback`, Buffer.from(JSON.stringify(rootFlashback, null, 2)));
        
        for (const file of content) {
            zip.addFile(`${issueFolderName}/${file.path}`, Buffer.from(file.content));
            zip.addFile(`${issueFolderName}/${file.path}.flashback`, Buffer.from(JSON.stringify(file.metadata, null, 2)));
        }

        return zip.toBuffer();
    };

    it('should import a new issue into an empty workspace', async () => {
        const issueId = "issue-1";
        const version = "v1.0.0";
        
        const issueContent = [
            {
                path: "Doc1.md",
                content: "# Document 1",
                metadata: {
                    globalHash: doc1Hash,
                    tags: ["Topic 1"],
                    flashcards: [
                        {
                            globalHash: fc1Hash,
                            vanillaData: { frontText: "Q1", backText: "A1" }
                        }
                    ]
                }
            }
        ];

        const issueZip = createIssueZip(issueId, version, issueContent);
        
        await subscriptions.importIssue(issueId, issueZip, TEST_ROOT);

        const doc = db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(path.join(TEST_ROOT, "Doc1.md"));
        assert.ok(doc, "Document should be imported");

        const fc = db.prepare('SELECT * FROM Flashcards WHERE document_id = ?').get(doc.id);
        assert.ok(fc, "Flashcard should be imported");

        const folderMeta = subscriptions.documents.files.getMetadata(TEST_ROOT, true);
        assert.equal(folderMeta.subscription.issueId, issueId);
        assert.equal(folderMeta.subscription.version, version);
    });

    it('should merge an updated issue and preserve user progress', async () => {
        await cleanup();
        // 1. Import initial issue
        const initialContent = [{
            path: "Doc1.md",
            content: "# Document 1 Original",
            metadata: {
                globalHash: doc1Hash,
                tags: ["Topic 1"],
                flashcards: [{ globalHash: fc1Hash, vanillaData: { frontText: "Q1 Original", backText: "A1 Original" } }]
            }
        }];
        const initialZip = createIssueZip("issue-2", "v1.0.0", initialContent);
        await subscriptions.importIssue("issue-2", initialZip, TEST_ROOT);
        
        const doc = db.prepare('SELECT id FROM Documents WHERE relative_path = ?').get(path.join(TEST_ROOT, "Doc1.md"));
        const fcInitial = db.prepare('SELECT id FROM Flashcards WHERE document_id = ?').get(doc.id);

        // 2. Simulate user progress
        db.prepare('UPDATE Flashcards SET level = 5 WHERE id = ?').run(fcInitial.id);

        // 3. Import updated issue
        const updatedContent = [{
            path: "Doc1.md",
            content: "# Document 1 Updated",
            metadata: {
                globalHash: doc1Hash,
                tags: ["Topic 1", "Updated"],
                flashcards: [{ globalHash: fc1Hash, vanillaData: { frontText: "Q1 Updated", backText: "A1 Updated" } }]
            }
        }];
        const updatedZip = createIssueZip("issue-3", "v1.1.0", updatedContent);
        await subscriptions.importIssue("issue-3", updatedZip, TEST_ROOT);

        // 4. Assertions
        const fc = db.prepare('SELECT * FROM Flashcards INNER JOIN FlashcardContent ON Flashcards.content_id = FlashcardContent.id WHERE Flashcards.id = ?').get(fcInitial.id);
        assert.equal(fc.level, 5, "Flashcard level should be preserved");
        assert.equal(fc.frontText, "Q1 Updated", "Flashcard content should be updated");

        const folderMeta = subscriptions.documents.files.getMetadata(TEST_ROOT, true);
        assert.equal(folderMeta.subscription.version, "v1.1.0");
    });

    it('should add new content from a new issue', async () => {
        await cleanup();
        // 1. Import initial issue
        const initialContent = [{
            path: "Doc1.md",
            content: "# Document 1 Original",
            metadata: {
                globalHash: doc1Hash,
                tags: ["Topic 1"],
                flashcards: [{ globalHash: fc1Hash, vanillaData: { frontText: "Q1 Original", backText: "A1 Original" } }]
            }
        }];
        const initialZip = createIssueZip("issue-2", "v1.0.0", initialContent);
        await subscriptions.importIssue("issue-2", initialZip, TEST_ROOT);

        // 2. Import new issue with additional content
        const newContent = [
        {
            path: "Doc1.md",
            content: "# Document 1 Updated",
            metadata: {
                globalHash: doc1Hash,
                tags: ["Topic 1", "Updated"],
                flashcards: [{ globalHash: fc1Hash, vanillaData: { frontText: "Q1 Updated", backText: "A1 Updated" } }]
            }
        },
        {
            path: "Doc2.md",
            content: "# Document 2",
            metadata: {
                globalHash: doc2Hash,
                tags: ["Topic 2"],
                flashcards: [{ globalHash: fc2Hash, vanillaData: { frontText: "Q2", backText: "A2" } }]
            }
        }];

        const issueZip = createIssueZip("issue-3", "v1.2.0", newContent);
        await subscriptions.importIssue("issue-3", issueZip, TEST_ROOT);

        const doc2 = db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(path.join(TEST_ROOT, "Doc2.md"));
        assert.ok(doc2, "New document should be added");
    });

    it('should remove content that is not in the new issue', async () => {
        await cleanup();
        // 1. Import initial issue with two documents
        const initialContent = [
            {
                path: "Doc1.md",
                content: "# Document 1",
                metadata: {
                    globalHash: doc1Hash,
                    tags: ["Topic 1"],
                    flashcards: [{ globalHash: fc1Hash, vanillaData: { frontText: "Q1", backText: "A1" } }]
                }
            },
            {
                path: "Doc2.md",
                content: "# Document 2",
                metadata: {
                    globalHash: doc2Hash,
                    tags: ["Topic 2"],
                    flashcards: [{ globalHash: fc2Hash, vanillaData: { frontText: "Q2", backText: "A2" } }]
                }
            }
        ];
        const initialZip = createIssueZip("issue-4", "v1.0.0", initialContent);
        await subscriptions.importIssue("issue-4", initialZip, TEST_ROOT);

        // 2. Import new issue with only one document
        const newContent = [{
            path: "Doc2.md",
            content: "# Document 2",
            metadata: {
                globalHash: doc2Hash,
                tags: ["Topic 2"],
                flashcards: [{ globalHash: fc2Hash, vanillaData: { frontText: "Q2", backText: "A2" } }]
            }
        }];
        const issueZip = createIssueZip("issue-5", "v1.3.0", newContent);
        await subscriptions.importIssue("issue-5", issueZip, TEST_ROOT);

        const oldDoc = db.prepare('SELECT * FROM Documents WHERE relative_path = ?').get(path.join(TEST_ROOT, "Doc1.md"));
        assert.strictEqual(oldDoc, undefined, "Doc1.md should have been removed");
    });
});
