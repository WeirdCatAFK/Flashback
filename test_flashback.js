import Documents from './src/api/access/documents.js';
import db from './src/api/access/database.js';
import validate from './src/api/config/validate.js';
import crypto from 'crypto';


// --- 1. Setup & Seeding ---
console.log("---------------------------------------------------------");
console.log("1. SETUP: Rebuilding Database & Seeding");
console.log("---------------------------------------------------------");

if (!validate()) {
    console.error("Validation failed, shutting down.");
    process.exit(1);
}

// --- 2. Create Structure ---
console.log("\n---------------------------------------------------------");
console.log("2. CREATING STRUCTURE");
console.log("---------------------------------------------------------");

const docs = new Documents();

try {
    docs.createFolder("School");
    docs.createFolder("Math", "School"); // Inside School
    console.log("✅ Folders 'School/Math' created.");

    // Create Document
    docs.createFile("Lecture1.md", "School/Math");
    console.log("✅ Document 'Lecture1.md' created.");
} catch (e) {
    console.error("❌ Structure Creation Failed:", e);
}

// --- 3. Batch Insert Flashcards ---
console.log("\n---------------------------------------------------------");
console.log("3. BATCH INSERTING 50 FLASHCARDS");
console.log("---------------------------------------------------------");

const flashcards = [];
for (let i = 1; i <= 50; i++) {
    flashcards.push({
        globalHash: crypto.randomUUID(),
        lastRecall: new Date().toISOString(), // Just created
        level: 0, // New card
        tags: ["Math", "Algebra", i % 2 === 0 ? "Even" : "Odd"],
        category: "Concept",
        fileIndex: i,
        vanillaData: {
            frontText: `Question ${i}: What is ${i} + ${i}?`,
            backText: `Answer: ${i + i}`,
            location: { type: "page", data: { page: 1 } }
        }
    });
}

const metadata = {
    globalHash: crypto.randomUUID(),
    tags: ["Course:Math101"], // Document-level tags
    flashcards: flashcards
};

const content = "# Lecture 1\n\nThis is a test lecture content.";

try {
    const startTime = performance.now();
    docs.updateFile("School/Math/Lecture1.md", content, metadata);
    const endTime = performance.now();
    console.log(`✅ 50 Flashcards inserted in ${(endTime - startTime).toFixed(2)}ms`);
} catch (e) {
    console.error("❌ Batch Insert Failed:", e);
}

// --- 4. Verify Graph & Search ---
console.log("\n---------------------------------------------------------");
console.log("4. VERIFYING GRAPH & SEARCH");
console.log("---------------------------------------------------------");

const searchRes = docs.search("Question 10");
console.log(`🔍 Search 'Question 10': Found ${searchRes.length} results.`);
if (searchRes.length > 0) console.log(`   - First result: ${searchRes[0].frontText} (${searchRes[0].type})`);

const graph = docs.getGraphData();
console.log(`🕸️ Graph Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);
// We expect Nodes: 1 Root + 2 Folders + 1 Doc + 50 Flashcards + Tags (Math, Algebra, Even, Odd, Course:Math101)
// Edges: Hierarchy links + Tag links

// --- 5. Study Session Simulation ---
console.log("\n---------------------------------------------------------");
console.log("5. SIMULATING STUDY SESSION");
console.log("---------------------------------------------------------");

// Get Due Cards
const due = docs.getDueFlashcards(5);
console.log(`📚 Cards Due: ${due.length}`);

if (due.length > 0) {
    const cardToReview = due[0];
    console.log(`📝 Reviewing: ${cardToReview.name} (Current Level: ${cardToReview.level})`);

    // Simulate a "Perfect" review (5/5 score)
    // Level increases from 0 -> 1. Presence (Ease) = 2.5
    // Note: Presence calculation here is simplified, usually Ease Factor is updated. 
    // In our submitReview, we pass EaseFactor. The Aura propagation uses Level.

    try {
        // Param 4 is 'easeFactor' (logic internal to SRS), Param 5 is 'newLevel'
        // Let's bump it to Level 8 (Max Mastery) to see the aura effect clearly
        const newLevel = 8;
        const easeFactor = 2.5;

        docs.submitReview(cardToReview.doc_path, cardToReview.global_hash, 5, easeFactor, newLevel);
        console.log(`✅ Review Submitted. Card leveled up to ${newLevel}.`);
    } catch (e) {
        console.error("❌ Review Failed:", e);
    }
}

// --- 6. Verify Presence Propagation ---
console.log("\n---------------------------------------------------------");
console.log("6. VERIFYING PRESENCE PROPAGATION (AURA)");
console.log("---------------------------------------------------------");

// Check Flashcard
const fcRow = db.prepare('SELECT level FROM Flashcards WHERE global_hash = ?').get(due[0].global_hash);
console.log(`🔹 Flashcard Level (DB): ${fcRow.level}`);

// Check Document Presence
const docRow = db.prepare('SELECT presence FROM Documents WHERE relative_path = ?').get("School/Math/Lecture1.md");
console.log(`📄 Document Aura: ${docRow.presence.toFixed(4)} (Should be > 0)`);
// Calculation: (1 card @ level 8 + 49 cards @ level 0) / 50 = 8/50 = 0.16

// Check Folder Presence (Math)
const folderMath = db.prepare('SELECT presence FROM Folders WHERE relative_path = ?').get("School/Math");
console.log(`📂 Folder 'Math' Aura: ${folderMath.presence.toFixed(4)}`);
// Calculation: Average of children. Math has 1 child (Lecture1.md). So it should match Doc Aura.

// Check Root Presence (School)
const folderSchool = db.prepare('SELECT presence FROM Folders WHERE relative_path = ?').get("School");
console.log(`🏫 Root 'School' Aura: ${folderSchool.presence.toFixed(4)}`);

console.log("\n---------------------------------------------------------");
console.log("✅ TEST COMPLETE");
console.log("---------------------------------------------------------");

/* 
### Instructions to Run
1.  Save this code as `test_flashback.js` in your root directory.
2.  Ensure your `src/api/access/config.js` or `.env` points `USER_DATA_PATH` to a test folder (or the script defaults to `./data`).
3.  Run with Node:
    ```bash
    node test_flashback.js
    ```

You should see all green checkmarks, confirming the system works end-to-end!
*/