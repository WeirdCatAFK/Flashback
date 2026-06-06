#!/usr/bin/env node
/**
 * Seed script — populates the Flashback database with realistic test data.
 *
 * Usage:
 *   npm run seed              # seeds %APPDATA%\flashback  (real Electron data)
 *   node scripts/seed.js      # same
 *
 * The script temporarily hides the Electron-compiled better-sqlite3 binary
 * (build/Debug) so that `bindings` falls through to a freshly-built
 * Release binary for the system Node version — the same trick used by
 * scripts/run-tests.js.  It restores the Electron binary on exit.
 *
 * WARNING: close the Electron app before running this script.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const root       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir   = path.join(root, 'node_modules', 'better-sqlite3', 'build');
const debugDir   = path.join(buildDir, 'Debug');
const electronDir = path.join(buildDir, 'Debug.electron');
const releaseDir = path.join(buildDir, 'Release');

// Binary swap: hide Electron build so bindings picks up the Release one

function restoreBinary() {
    try {
        if (fs.existsSync(electronDir)) {
            if (fs.existsSync(debugDir)) fs.rmSync(debugDir, { recursive: true, force: true });
            fs.renameSync(electronDir, debugDir);
        }
    } catch (e) {
        console.warn('Warning: could not restore Electron binary:', e.message);
    }
    // Release cleanup is best-effort; if locked on Windows it will be cleaned next rebuild
    try { if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true }); } catch (_) {}
}

process.on('exit', restoreBinary);
process.on('SIGINT', () => { restoreBinary(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); restoreBinary(); process.exit(1); });

if (fs.existsSync(debugDir)) {
    try {
        fs.renameSync(debugDir, electronDir);
    } catch (e) {
        console.error(
            'ERROR: Could not rename the Electron better-sqlite3 binary.\n' +
            'Make sure the Flashback Electron app is closed, then try again.\n\n' +
            e.message
        );
        process.exit(1);
    }
}

console.log('Building better-sqlite3 for system Node...');
try {
    execSync('npm rebuild better-sqlite3', { stdio: 'inherit', cwd: root });
} catch {
    restoreBinary();
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Now that the right binary is in place, dynamically import everything
// ---------------------------------------------------------------------------

const { default: crypto } = await import('crypto');

// Point to the real Electron userData by default
const appDataPath = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'flashback')
    : path.join(root, 'data');

process.env.USER_DATA_PATH = appDataPath;
console.log(`\nUsing data path: ${appDataPath}\n`);

const { default: validate }   = await import('../src/api/config/validate.js');
const { sealTools }            = await import('../src/api/seal/seal.js');
const { default: Documents }  = await import('../src/api/access/documents.js');
const { default: query }      = await import('../src/api/access/query.js');

if (!validate()) {
    console.error('Validation failed — check your data directory.');
    process.exit(1);
}
await sealTools.init();

const docs = new Documents();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() { return crypto.randomUUID(); }

function card(front, back, opts = {}) {
    return {
        globalHash: uuid(),
        level: opts.level ?? 0,
        lastRecall: opts.lastRecall ?? null,
        cardType: opts.cardType ?? 'basic',
        category: opts.category ?? null,
        name: opts.name ?? null,
        tags: opts.tags ?? [],
        reviewCount: opts.reviewCount ?? 0,
        customData: { html: '' },
        vanillaData: {
            frontText: front,
            backText: back,
            media: { front_img: null, back_img: null, front_sound: null, back_sound: null },
            location: null,
        },
    };
}

const cloze    = (f, b, o = {}) => card(f, b, { ...o, cardType: 'cloze' });
const flip     = (f, b, o = {}) => card(f, b, { ...o, cardType: 'reversible' });
const typed    = (f, b, o = {}) => card(f, b, { ...o, cardType: 'type_answer' });
const custom   = (html, o = {}) => ({
    globalHash: uuid(), level: 0, lastRecall: null, cardType: 'custom',
    category: o.category ?? null, name: o.name ?? null, tags: o.tags ?? [], reviewCount: 0,
    customData: { html },
    vanillaData: {
        frontText: '', backText: '',
        media: { front_img: null, back_img: null, front_sound: null, back_sound: null },
        location: null,
    },
});

async function mkFolder(name, parent = '') {
    try {
        await docs.createFolder(name, parent);
        console.log(`  folder  ${parent ? parent + '/' : ''}${name}`);
    } catch (e) {
        if (e.message?.includes('already exists') || e.code === 'EEXIST') {
            console.log(`  exists  ${parent ? parent + '/' : ''}${name}`);
        } else throw e;
    }
}

async function mkFile(name, folder, content, metadata) {
    try {
        await docs.importFile(name, folder, content, metadata);
        console.log(`  file    ${folder}/${name}  (${metadata.flashcards?.length ?? 0} cards)`);
    } catch (e) {
        if (e.message?.includes('already exists') || e.code === 'EEXIST') {
            console.log(`  exists  ${folder}/${name}`);
        } else throw e;
    }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// ── Biology ─────────────────────────────────────────────────────────────────
console.log('\n── Biology ──────────────────────────────────────────────');
await mkFolder('Biology');

const cellBioCards = [
    card('What is the powerhouse of the cell?', 'Mitochondria', { category: 'Definition', reviewCount: 4 }),
    cloze("The {{nucleus}} contains the cell's DNA.", 'nucleus', { category: 'Concept' }),
    card('What are the four phases of mitosis?', 'Prophase → Metaphase → Anaphase → Telophase', { category: 'Concept', reviewCount: 3 }),
    flip('Endoplasmic Reticulum', 'Organelle responsible for protein synthesis (rough ER) and lipid synthesis (smooth ER)', { category: 'Definition' }),
    card('What is the difference between prokaryotic and eukaryotic cells?', 'Prokaryotes lack a membrane-bound nucleus; eukaryotes have a true nucleus', { category: 'Concept', reviewCount: 2 }),
    typed('What organelle packages proteins for secretion?', 'Golgi apparatus', { category: 'Terminology' }),
];

await mkFile('Cell Biology.md', 'Biology',
`# Cell Biology

Cell biology covers the structure, function, and behavior of cells.

## Key Organelles
- **Nucleus** — control center, contains DNA
- **Mitochondria** — ATP production via cellular respiration
- **Ribosomes** — protein synthesis
- **ER** — protein and lipid synthesis/transport
- **Golgi apparatus** — protein packaging and secretion
`,  { globalHash: uuid(), tags: ['Biology', 'Cells'], flashcards: cellBioCards });

const geneticsCards = [
    card("What is a gene?", 'A segment of DNA that encodes a functional product, usually a protein', { category: 'Definition', reviewCount: 4 }),
    flip('Phenotype', 'The observable physical characteristics of an organism', { category: 'Terminology' }),
    flip('Genotype', 'The genetic makeup of an organism', { category: 'Terminology' }),
    cloze('DNA replication is {{semiconservative}}, meaning each new molecule retains one original strand.', 'semiconservative', { category: 'Concept', reviewCount: 2 }),
    card("What is Mendel's Law of Segregation?", 'Each organism carries two alleles for each trait; they separate during gamete formation', { category: 'Concept' }),
    typed('What bases pair with each other in DNA?', 'A-T and G-C', { category: 'Concept', reviewCount: 3 }),
    custom(`<div style="padding:1rem;background:#fef3c7;border-radius:8px">
  <h3>Punnett Square — Monohybrid Cross</h3>
  <table style="border-collapse:collapse;margin:auto">
    <tr><td></td><td><b>B</b></td><td><b>b</b></td></tr>
    <tr><td><b>B</b></td><td style="border:1px solid #ccc;padding:8px">BB</td><td style="border:1px solid #ccc;padding:8px">Bb</td></tr>
    <tr><td><b>b</b></td><td style="border:1px solid #ccc;padding:8px">Bb</td><td style="border:1px solid #ccc;padding:8px">bb</td></tr>
  </table>
  <p style="text-align:center;margin-top:.5rem">Ratio: 1 BB : 2 Bb : 1 bb</p>
</div>`, { category: 'Example' }),
];

await mkFile('Genetics.md', 'Biology',
`# Genetics

The study of heredity and variation in living organisms.

## Central Dogma
DNA → RNA → Protein

## Mendelian Genetics
Mendel's pea plant experiments established the foundation of classical genetics.
`,  { globalHash: uuid(), tags: ['Biology', 'Genetics'], flashcards: geneticsCards });

// ── Computer Science ─────────────────────────────────────────────────────────
console.log('\n── Computer Science ─────────────────────────────────────');
await mkFolder('Computer Science');

const dsCards = [
    card('What is the time complexity of binary search?', 'O(log n)', { category: 'Concept', reviewCount: 4 }),
    card('What is the time complexity of quicksort (average case)?', 'O(n log n)', { category: 'Concept', reviewCount: 3 }),
    flip('Stack', 'LIFO (Last In, First Out) data structure', { category: 'Definition' }),
    flip('Queue', 'FIFO (First In, First Out) data structure', { category: 'Definition' }),
    cloze('A {{hash table}} provides O(1) average-case lookup by mapping keys to indices via a hash function.', 'hash table', { category: 'Concept', reviewCount: 2 }),
    card('What is a balanced BST?', 'A binary search tree where the height difference between left and right subtrees is at most 1', { category: 'Definition' }),
    typed('What data structure does BFS use internally?', 'Queue', { category: 'Concept', reviewCount: 4 }),
    typed('What data structure does DFS use internally?', 'Stack (or the call stack for recursion)', { category: 'Concept', reviewCount: 3 }),
];

await mkFile('Data Structures.md', 'Computer Science',
`# Data Structures

Fundamental data structures and their complexity characteristics.

| Structure   | Access   | Search   | Insert   | Delete   |
|-------------|----------|----------|----------|----------|
| Array       | O(1)     | O(n)     | O(n)     | O(n)     |
| Linked List | O(n)     | O(n)     | O(1)     | O(1)     |
| Hash Table  | —        | O(1)     | O(1)     | O(1)     |
| BST         | O(log n) | O(log n) | O(log n) | O(log n) |
`,  { globalHash: uuid(), tags: ['CS', 'Algorithms'], flashcards: dsCards });

const netCards = [
    card('What does TCP stand for?', 'Transmission Control Protocol', { category: 'Terminology', reviewCount: 2 }),
    card('What is the difference between TCP and UDP?', 'TCP is connection-oriented and reliable; UDP is connectionless and faster but unreliable', { category: 'Concept', reviewCount: 3 }),
    card('What does DNS do?', 'Translates human-readable domain names into IP addresses', { category: 'Definition', reviewCount: 4 }),
    cloze('The {{OSI}} model has 7 layers: Physical, Data Link, Network, Transport, Session, Presentation, Application.', 'OSI', { category: 'Concept' }),
    flip('HTTP 200', 'OK — the request succeeded', { category: 'Example' }),
    flip('HTTP 404', 'Not Found — the resource does not exist', { category: 'Example' }),
    flip('HTTP 500', 'Internal Server Error', { category: 'Example' }),
    typed('What port does HTTPS run on by default?', '443', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('Networking.md', 'Computer Science',
`# Networking

Fundamentals of computer networking.

## The OSI Model
1. Physical
2. Data Link
3. Network
4. Transport
5. Session
6. Presentation
7. Application
`,  { globalHash: uuid(), tags: ['CS', 'Networking'], flashcards: netCards });

// ── Mathematics ───────────────────────────────────────────────────────────────
console.log('\n── Mathematics ──────────────────────────────────────────');
await mkFolder('Mathematics');

const calcCards = [
    card('What is the derivative of sin(x)?', 'cos(x)', { category: 'Symbol', reviewCount: 4 }),
    card('What is the derivative of eˣ?', 'eˣ', { category: 'Symbol', reviewCount: 4 }),
    card('What is the chain rule?', "d/dx[f(g(x))] = f'(g(x)) · g'(x)", { category: 'Concept', reviewCount: 3 }),
    cloze('The {{fundamental theorem of calculus}} states that differentiation and integration are inverse operations.', 'fundamental theorem of calculus', { category: 'Concept' }),
    card('What is a limit?', 'The value a function approaches as the input approaches some value', { category: 'Definition', reviewCount: 2 }),
    typed('What is ∫x dx?', 'x²/2 + C', { category: 'Symbol', reviewCount: 3 }),
    flip('Product Rule', "d/dx[f·g] = f'g + fg'", { category: 'Concept' }),
    flip('Quotient Rule', "d/dx[f/g] = (f'g − fg') / g²", { category: 'Concept' }),
];

await mkFile('Calculus.md', 'Mathematics',
`# Calculus

Differential and integral calculus.

## Key Derivatives
- d/dx[xⁿ] = nxⁿ⁻¹
- d/dx[sin x] = cos x
- d/dx[cos x] = −sin x
- d/dx[eˣ] = eˣ
- d/dx[ln x] = 1/x
`,  { globalHash: uuid(), tags: ['Math', 'Calculus'], flashcards: calcCards });

const laCards = [
    flip('Matrix multiplication', 'The dot product of rows of A with columns of B; only defined when cols(A) = rows(B)', { category: 'Concept', reviewCount: 2 }),
    card('What is the determinant of a 2×2 matrix [[a,b],[c,d]]?', 'ad − bc', { category: 'Symbol', reviewCount: 3 }),
    card('What does it mean for vectors to be linearly independent?', 'No vector in the set can be written as a linear combination of the others', { category: 'Definition' }),
    cloze('An {{eigenvalue}} λ satisfies Av = λv, where v is the eigenvector.', 'eigenvalue', { category: 'Concept' }),
    typed("What is the identity matrix's effect on a vector?", 'It returns the vector unchanged: Iv = v', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('Linear Algebra.md', 'Mathematics',
`# Linear Algebra

Vectors, matrices, and linear transformations.

## Core Concepts
- **Vector space** — a set of vectors closed under addition and scalar multiplication
- **Matrix** — a rectangular array representing a linear transformation
- **Eigenvalue/Eigenvector** — directions unchanged by a transformation, scaled by λ
`,  { globalHash: uuid(), tags: ['Math', 'LinearAlgebra'], flashcards: laCards });

// ── History ───────────────────────────────────────────────────────────────────
console.log('\n── History ──────────────────────────────────────────────');
await mkFolder('History');

const wwiiCards = [
    card('When did World War II begin?', 'September 1, 1939 — Germany invaded Poland', { category: 'Concept', reviewCount: 3 }),
    card('When did World War II end?', 'September 2, 1945 — Japan signed the surrender', { category: 'Concept', reviewCount: 3 }),
    card("What was D-Day?", 'June 6, 1944 — Allied invasion of Normandy, France', { category: 'Definition', reviewCount: 4 }),
    cloze('The {{Manhattan Project}} was the Allied research program that developed the first nuclear weapons.', 'Manhattan Project', { category: 'Concept', reviewCount: 2 }),
    flip('Blitzkrieg', 'German military strategy of rapid, coordinated attacks using tanks and air support', { category: 'Terminology' }),
    typed('Who was the Allied Supreme Commander in Europe?', 'Dwight D. Eisenhower', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('World War II.md', 'History',
`# World War II

The global conflict from 1939 to 1945.

## Key Theaters
- **European Theater** — Western Front, Eastern Front, North Africa, Italy
- **Pacific Theater** — Japan vs. Allied forces

## Major Turning Points
- Battle of Stalingrad (1942–43)
- D-Day / Operation Overlord (1944)
- Atomic bombs on Hiroshima and Nagasaki (1945)
`,  { globalHash: uuid(), tags: ['History', 'WWII'], flashcards: wwiiCards });

// ── Physics ───────────────────────────────────────────────────────────────────
console.log('\n── Physics ──────────────────────────────────────────────');
await mkFolder('Physics');

const mechCards = [
    card("State Newton's First Law.", 'An object at rest stays at rest, and an object in motion stays in motion, unless acted upon by a net external force.', { category: 'Concept', reviewCount: 4 }),
    card("State Newton's Second Law.", 'F = ma — net force equals mass times acceleration', { category: 'Symbol', reviewCount: 4 }),
    card("State Newton's Third Law.", 'For every action there is an equal and opposite reaction.', { category: 'Concept', reviewCount: 3 }),
    typed('What is the SI unit of force?', 'Newton (N)', { category: 'Terminology', reviewCount: 3 }),
    cloze('Kinetic energy is defined as {{½mv²}}, where m is mass and v is velocity.', '½mv²', { category: 'Symbol', reviewCount: 2 }),
    flip('Work (physics)', 'W = F · d · cos(θ) — force applied over a displacement', { category: 'Symbol' }),
    card('What is the law of conservation of energy?', 'Energy cannot be created or destroyed, only converted from one form to another', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('Classical Mechanics.md', 'Physics',
`# Classical Mechanics

Newtonian mechanics and fundamental motion.

## Newton's Laws
1. Inertia
2. F = ma
3. Action–reaction pairs

## Energy
- Kinetic energy: KE = ½mv²
- Potential energy: PE = mgh
- Conservation: KE + PE = constant (closed system)
`,  { globalHash: uuid(), tags: ['Physics', 'Mechanics'], flashcards: mechCards });

// ---------------------------------------------------------------------------
// Seed review history
// ---------------------------------------------------------------------------

console.log('\n── Seeding review history ───────────────────────────────');

const allCards = [
    ...cellBioCards, ...geneticsCards,
    ...dsCards, ...netCards,
    ...calcCards, ...laCards,
    ...wwiiCards, ...mechCards,
];

const pastDate = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
};

const sessions = [
    { daysAgo: 14, outcome: 'again', easeFactor: 2.5, level: 0 },
    { daysAgo: 10, outcome: 'hard',  easeFactor: 2.3, level: 1 },
    { daysAgo:  6, outcome: 'good',  easeFactor: 2.5, level: 2 },
    { daysAgo:  2, outcome: 'easy',  easeFactor: 2.7, level: 3 },
];

let reviewsAdded = 0;
for (const fc of allCards) {
    if (!fc.reviewCount) continue;
    const dbCard = query.getFlashcardByHash(fc.globalHash);
    if (!dbCard) continue;

    const history = sessions.slice(0, fc.reviewCount);
    for (const s of history) {
        try {
            query.insertReviewLog({
                flashcardId: dbCard.id,
                timestamp: pastDate(s.daysAgo),
                outcome: s.outcome,
                easeFactor: s.easeFactor,
                level: s.level,
            });
            reviewsAdded++;
        } catch (_) {}
    }

    const last = history[history.length - 1];
    query.updateFlashcardReview(dbCard.id, pastDate(last.daysAgo), last.level);
}

console.log(`  ${reviewsAdded} review log entries inserted`);
console.log('\n✓ Seed complete.\n');
