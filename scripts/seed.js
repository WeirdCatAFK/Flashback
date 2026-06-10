#!/usr/bin/env node
/**
 * Seed script — populates Flashback with a rich demo workspace.
 *
 * Demonstrates: nested folders, tag inheritance + excluded tags, all 5
 * flashcard types, all 6 pedagogical categories, text/bbox highlights,
 * 4 decks, and review history at Leitner levels 1–5.
 *
 * Usage:
 *   npm run seed        # seeds %APPDATA%\flashback (real Electron data)
 *   node scripts/seed.js
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

function restoreBinary() {
    try {
        if (fs.existsSync(electronDir)) {
            if (fs.existsSync(debugDir)) fs.rmSync(debugDir, { recursive: true, force: true });
            fs.renameSync(electronDir, debugDir);
        }
    } catch (e) { console.warn('Warning: could not restore Electron binary:', e.message); }
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
// Dynamic imports (binary swap must complete first)
// ---------------------------------------------------------------------------

const { default: crypto } = await import('crypto');

const appDataPath = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'flashback')
    : path.join(root, 'data');

process.env.USER_DATA_PATH = appDataPath;
console.log(`\nUsing data path: ${appDataPath}\n`);

const { default: validate }  = await import('../src/api/config/validate.js');
const { sealTools }          = await import('../src/api/seal/seal.js');
const { default: Documents } = await import('../src/api/access/documents.js');
const { default: Decks }     = await import('../src/api/access/decks.js');
const { default: query }     = await import('../src/api/access/query.js');

if (!validate()) {
    console.error('Validation failed — check your data directory.');
    process.exit(1);
}
await sealTools.init();

const docs  = new Documents();
const decks = new Decks();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() { return crypto.randomUUID(); }

function pastDate(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
}

function card(front, back, opts = {}) {
    return {
        globalHash: uuid(),
        level: 0,
        lastRecall: null,
        cardType: opts.cardType ?? 'basic',
        category: opts.category ?? null,
        name: opts.name ?? null,
        tags: [],
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

const cloze  = (f, b, o = {}) => card(f, b, { ...o, cardType: 'cloze' });
const flip   = (f, b, o = {}) => card(f, b, { ...o, cardType: 'reversible' });
const typed  = (f, b, o = {}) => card(f, b, { ...o, cardType: 'type_answer' });
const custom = (html, o = {}) => ({
    globalHash: uuid(), level: 0, lastRecall: null, cardType: 'custom',
    category: o.category ?? null, name: o.name ?? null, tags: [], reviewCount: 0,
    customData: { html },
    vanillaData: {
        frontText: '', backText: '',
        media: { front_img: null, back_img: null, front_sound: null, back_sound: null },
        location: null,
    },
});

function hl(opts = {}) {
    return {
        id: uuid(),
        type: opts.type ?? 'text_offset',
        start: opts.start ?? null,
        end:   opts.end   ?? null,
        page:  opts.page  ?? null,
        bbox:  opts.bbox  ?? null,
        color: opts.color ?? 'amber',
        note:  opts.note  ?? '',
        createdAt: pastDate(opts.daysAgo ?? 3),
    };
}

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
        const c = metadata.flashcards?.length ?? 0;
        const h = metadata.highlights?.length ?? 0;
        console.log(`  file    ${folder}/${name}  (${c} cards${h ? ', ' + h + ' highlights' : ''})`);
    } catch (e) {
        if (e.message?.includes('already exists') || e.code === 'EEXIST') {
            console.log(`  exists  ${folder}/${name}`);
        } else throw e;
    }
}

async function setFolderTags(folderPath, tags, excludedTags = []) {
    // path.normalize converts forward slashes to backslashes on Windows,
    // matching the storage format used by createFolder (which calls path.join).
    const normPath = path.normalize(folderPath);
    const existing = docs.files.getMetadata(normPath, true) || {};
    await docs.updateMetadata(normPath, { ...existing, tags, excludedTags }, true);
    const note = excludedTags.length ? ` (excl: ${excludedTags.join(', ')})` : '';
    console.log(`  tags    ${folderPath}  [${tags.join(', ')}]${note}`);
}

function mkDeck(name, description) {
    const hash = decks.createDeck(name, description);
    console.log(`  deck    "${name}"`);
    return hash;
}

function populateDeck(deckHash, entries) {
    let n = 0;
    for (const { c, docPath } of entries) {
        try {
            decks.addEntry(deckHash, { cardHash: c.globalHash, documentPath: docPath });
            n++;
        } catch (e) {
            if (!e.message?.includes('already in deck')) console.warn(`    warn: ${e.message}`);
        }
    }
    return n;
}

// ---------------------------------------------------------------------------
// ── STEP 1: Folder hierarchy ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

console.log('\n── Creating folder hierarchy ────────────────────────────');

await mkFolder('Science');
await mkFolder('Biology',      'Science');
await mkFolder('Microbiology', 'Science/Biology');
await mkFolder('Physics',      'Science');

await mkFolder('Computer Science');
await mkFolder('Algorithms', 'Computer Science');

await mkFolder('Mathematics');

await mkFolder('Humanities');
await mkFolder('History',    'Humanities');
await mkFolder('Philosophy', 'Humanities');

// ---------------------------------------------------------------------------
// ── STEP 2: Files ────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

// ── Science / Biology / Cell Biology ────────────────────────────────────────
console.log('\n── Science / Biology ────────────────────────────────────');

const cellBioCards = [
    card('What is the powerhouse of the cell?', 'Mitochondria — produces ATP via oxidative phosphorylation', { category: 'Definition', reviewCount: 5 }),
    cloze("The {{nucleus}} contains the cell's DNA and directs gene expression.", 'nucleus', { category: 'Concept', reviewCount: 4 }),
    card('What are the four phases of mitosis?', 'Prophase → Metaphase → Anaphase → Telophase', { category: 'Concept', reviewCount: 3 }),
    flip('Endoplasmic Reticulum', 'Rough ER: protein synthesis (studded with ribosomes). Smooth ER: lipid synthesis, Ca²⁺ storage', { category: 'Definition', reviewCount: 2 }),
    typed('What organelle packages proteins for secretion?', 'Golgi apparatus', { category: 'Terminology', reviewCount: 4 }),
    card('What is the function of lysosomes?', 'Digest cellular waste using ~60 hydrolytic enzymes; pH ~4.8', { category: 'Definition', reviewCount: 1 }),
    custom(`<div style="padding:1rem;background:#ecfdf5;border-radius:8px;border:1px solid #6ee7b7">
  <h3 style="margin:0 0 .5rem;color:#065f46">Cell Membrane — Fluid Mosaic Model</h3>
  <ul style="font-size:.9rem;margin:.5rem 0 0;padding-left:1.2rem">
    <li><b>Phospholipid bilayer</b> — hydrophilic heads outward, hydrophobic tails inward</li>
    <li><b>Integral proteins</b> — span the bilayer (ion channels, pumps, receptors)</li>
    <li><b>Peripheral proteins</b> — surface-attached (signal transduction)</li>
    <li><b>Cholesterol</b> — regulates membrane fluidity across temperatures</li>
  </ul>
</div>`, { category: 'Concept' }),
];

await mkFile('Cell Biology.md', 'Science/Biology', `# Cell Biology

Cell biology covers the structure, function, and behavior of cells — the fundamental units of life.

## Key Organelles
- **Nucleus** — control center; contains DNA and directs gene expression
- **Mitochondria** — ATP production via cellular respiration (Krebs cycle + oxidative phosphorylation)
- **Ribosomes** — protein synthesis; free ribosomes → cytoplasmic proteins; ER-bound → secretory proteins
- **Endoplasmic Reticulum** — rough ER (protein synthesis/transport); smooth ER (lipid synthesis, Ca²⁺ storage)
- **Golgi apparatus** — protein packaging, modification, and secretion routing
- **Lysosomes** — waste digestion; ~60 hydrolytic enzymes; pH ≈ 4.8
- **Peroxisomes** — fatty acid oxidation, H₂O₂ detoxification

## Cell Membrane
Fluid mosaic model: phospholipid bilayer with embedded proteins and cholesterol.

## Mitosis vs Meiosis
| Feature | Mitosis | Meiosis |
|---------|---------|---------|
| Purpose | Growth / repair | Sexual reproduction |
| Daughter cells | 2 (diploid 2n) | 4 (haploid n) |
| Divisions | 1 | 2 |
| Crossing over | No | Yes |
`, {
    globalHash: uuid(),
    tags: ['CellBiology'],
    flashcards: cellBioCards,
    highlights: [
        hl({ type: 'text_offset', start: 16,  end: 95,  color: 'amber',  note: 'Core definition — powerhouse of the cell',   daysAgo: 7 }),
        hl({ type: 'text_offset', start: 206, end: 320, color: 'blue',   note: 'Organelle list — memorize for exam',          daysAgo: 3 }),
    ],
});

// ── Genetics ─────────────────────────────────────────────────────────────────

const geneticsCards = [
    card('What is a gene?', 'A DNA segment encoding a functional product (protein or RNA); unit of heredity', { category: 'Definition', reviewCount: 4 }),
    flip('Phenotype', 'Observable physical traits of an organism (result of genotype × environment)', { category: 'Terminology', reviewCount: 3 }),
    flip('Genotype', 'Complete genetic makeup — specific allele combinations carried by an organism', { category: 'Terminology', reviewCount: 3 }),
    cloze('DNA replication is {{semiconservative}}: each new molecule retains one original strand and one newly synthesized strand.', 'semiconservative', { category: 'Concept', reviewCount: 2 }),
    typed('What base pairs are found in DNA? (format: X-Y and A-B)', 'A-T and G-C', { category: 'Symbol', reviewCount: 4 }),
    custom(`<div style="padding:1rem;background:#fef3c7;border-radius:8px;border:1px solid #fbbf24">
  <h3 style="margin:0 0 .5rem;color:#92400e">Punnett Square — Monohybrid (Bb × Bb)</h3>
  <table style="border-collapse:collapse;margin:.5rem auto;text-align:center;font-size:.9rem">
    <tr><td style="padding:6px"></td><td style="padding:6px"><b>B</b></td><td style="padding:6px"><b>b</b></td></tr>
    <tr>
      <td style="padding:6px"><b>B</b></td>
      <td style="border:1px solid #d97706;padding:8px 14px">BB</td>
      <td style="border:1px solid #d97706;padding:8px 14px">Bb</td>
    </tr>
    <tr>
      <td style="padding:6px"><b>b</b></td>
      <td style="border:1px solid #d97706;padding:8px 14px">Bb</td>
      <td style="border:1px solid #d97706;padding:8px 14px">bb</td>
    </tr>
  </table>
  <p style="text-align:center;margin:.5rem 0 0;font-size:.85rem">
    Genotype ratio 1 BB : 2 Bb : 1 bb → <b>3 dominant : 1 recessive</b>
  </p>
</div>`, { category: 'Example' }),
];

await mkFile('Genetics.md', 'Science/Biology', `# Genetics

The study of heredity and genetic variation in living organisms.

## Central Dogma
DNA → (Transcription) → mRNA → (Translation) → Protein

Replication preserves the sequence; transcription reads it; translation decodes it.

## Mendelian Genetics
Mendel's pea plant experiments (1860s) established the foundational laws of inheritance.

### Law of Segregation
Each organism carries two alleles per trait; they segregate during gamete formation.

### Law of Independent Assortment
Alleles of unlinked genes assort independently (applies to genes on different chromosomes).

## Mutations
- **Point mutation** — single base substitution
- **Frameshift** — insertion/deletion shifts the reading frame
- **Chromosomal** — large-scale rearrangements (deletion, duplication, inversion, translocation)
`, {
    globalHash: uuid(),
    tags: ['Genetics'],
    flashcards: geneticsCards,
    highlights: [
        hl({ type: 'text_offset', start: 52, end: 130, color: 'green', note: 'Central dogma — critical concept', daysAgo: 5 }),
    ],
});

// ── Microbiology — STEM tag excluded ─────────────────────────────────────────
console.log('\n── Science / Biology / Microbiology (STEM excluded) ─────');

const bacteriaCards = [
    card('What is the difference between gram-positive and gram-negative bacteria?', 'Gram+: thick peptidoglycan, no outer membrane → purple stain. Gram−: thin peptidoglycan + LPS outer membrane → pink stain.', { category: 'Concept', reviewCount: 3 }),
    flip('Prokaryote', 'Cell without a membrane-bound nucleus; includes bacteria and archaea; ~1–10 µm', { category: 'Definition', reviewCount: 2 }),
    cloze('Viruses are {{obligate intracellular parasites}} — they require a living host cell to replicate.', 'obligate intracellular parasites', { category: 'Definition', reviewCount: 1 }),
    typed('What is horizontal gene transfer via direct cell-to-cell contact called?', 'Conjugation', { category: 'Concept', reviewCount: 2 }),
    card('Describe the lytic vs lysogenic phage cycle.', 'Lytic: immediate replication → host lysis → phage release. Lysogenic: phage DNA integrates as prophage → replicates with host → can switch to lytic on induction.', { category: 'Concept', reviewCount: 1 }),
];

await mkFile('Bacteria & Viruses.md', 'Science/Biology/Microbiology', `# Bacteria & Viruses

## Bacteria
Prokaryotes: circular chromosome, no nucleus, 1–10 µm. Reproduce via binary fission.

### Gram Staining
- **Gram-positive (+)**: thick peptidoglycan cell wall → retains crystal violet → purple
- **Gram-negative (−)**: thin peptidoglycan + LPS outer membrane → counterstains pink

## Viruses
Non-living obligate intracellular parasites. Nucleic acid (DNA or RNA) inside a protein capsid.

### Bacteriophage Life Cycles
1. **Lytic** — replication → lysis → new phages released (immediate)
2. **Lysogenic** — DNA integrates as prophage → dormant; induction triggers lytic switch

## Antibiotic Resistance
Acquired via mutation or horizontal gene transfer:
- **Conjugation** — direct cell contact, plasmid transfer (most common)
- **Transformation** — uptake of naked DNA from environment
- **Transduction** — phage-mediated DNA transfer between bacteria
`, {
    globalHash: uuid(),
    tags: ['Microbiology'],
    flashcards: bacteriaCards,
});

// ── Physics ───────────────────────────────────────────────────────────────────
console.log('\n── Science / Physics ────────────────────────────────────');

const mechCards = [
    card("State Newton's First Law.", 'An object at rest stays at rest; an object in motion stays in motion at constant velocity — unless acted on by a net external force. (Law of Inertia)', { category: 'Concept', reviewCount: 5 }),
    card("State Newton's Second Law.", 'F = ma — net force equals mass × acceleration; vector equation; F and a always share direction', { category: 'Symbol', reviewCount: 5 }),
    card("State Newton's Third Law.", 'For every action there is an equal and opposite reaction — forces always occur in pairs', { category: 'Concept', reviewCount: 4 }),
    typed('What is the SI unit of force?', 'Newton (N) = kg·m/s²', { category: 'Terminology', reviewCount: 4 }),
    cloze('Kinetic energy is KE = {{½mv²}}, where m is mass (kg) and v is speed (m/s).', '½mv²', { category: 'Symbol', reviewCount: 3 }),
    flip('Work (physics)', 'W = F·d·cos θ  [Joules] — dot product of force and displacement vectors', { category: 'Symbol', reviewCount: 2 }),
    card('What is conservation of momentum?', 'In an isolated system (no external forces), total momentum p = mv is constant: Σp_before = Σp_after', { category: 'Concept', reviewCount: 1 }),
];

await mkFile('Classical Mechanics.md', 'Science/Physics', `# Classical Mechanics

Newtonian mechanics governing macroscopic objects at non-relativistic speeds.

## Newton's Laws
1. **Inertia** — objects resist changes in motion
2. **F = ma** — net force produces proportional acceleration
3. **Action–reaction** — forces always come in equal, opposite pairs

## Energy and Work
| Quantity | Formula | Unit |
|----------|---------|------|
| Work | W = F·d·cosθ | Joule (J) |
| Kinetic energy | KE = ½mv² | J |
| Gravitational PE | PE = mgh | J |
| Power | P = W/t | Watt (W) |

Conservation of energy: KE + PE = constant (no friction).

## Kinematics (constant acceleration)
- v = v₀ + at
- x = v₀t + ½at²
- v² = v₀² + 2ax

## Momentum
- p = mv  (vector)
- Impulse: J = FΔt = Δp
- Conservation: Σp = constant in isolated system
`, {
    globalHash: uuid(),
    tags: ['Mechanics'],
    flashcards: mechCards,
});

const quantumCards = [
    card("State Heisenberg's Uncertainty Principle.", "Δx·Δp ≥ ℏ/2 — the more precisely a particle's position is known, the less precisely its momentum can be known, and vice versa", { category: 'Concept', reviewCount: 4 }),
    flip('Wave–particle duality', 'Quantum objects exhibit wave-like behavior (interference, diffraction) AND particle-like behavior (photoelectric effect) depending on the experiment', { category: 'Concept', reviewCount: 3 }),
    cloze("Schrödinger's equation describes the {{wavefunction}} Ψ; |Ψ|² gives the probability density of finding a particle at a given location.", 'wavefunction', { category: 'Concept', reviewCount: 2 }),
    typed('What does the photoelectric effect prove about light?', 'Light is quantized into photons with energy E = hf; below threshold frequency no electrons are emitted regardless of intensity', { category: 'Example', reviewCount: 3 }),
    card('What are the four quantum numbers?', 'Principal (n), Angular momentum (ℓ), Magnetic (mₗ), Spin (mₛ)', { category: 'Concept', reviewCount: 1 }),
];

await mkFile('Quantum Mechanics.md', 'Science/Physics', `# Quantum Mechanics

Theory governing matter and energy at atomic and subatomic scales.

## Wave–Particle Duality
Quantum objects behave as waves (double-slit interference) and particles (photoelectric effect).
de Broglie wavelength: λ = h/p

## Heisenberg Uncertainty Principle
**Δx · Δp ≥ ℏ/2**

Fundamental — not an instrument limitation; a property of nature itself.

## Schrödinger's Equation
iℏ ∂Ψ/∂t = ĤΨ

The wavefunction Ψ encodes all measurable information. |Ψ|² = probability density.

## Quantum Numbers
| Symbol | Name | Values |
|--------|------|--------|
| n | Principal | 1, 2, 3, … |
| ℓ | Angular momentum | 0 to n−1 |
| mₗ | Magnetic | −ℓ to +ℓ |
| mₛ | Spin | +½, −½ |

## Key Phenomena
- **Superposition** — particle exists in multiple states until measured
- **Entanglement** — correlated particles share quantum state instantaneously
- **Tunneling** — particle passes through a classically forbidden energy barrier
`, {
    globalHash: uuid(),
    tags: ['QuantumPhysics'],
    flashcards: quantumCards,
    highlights: [
        hl({ type: 'text_offset', start: 60,  end: 175, color: 'purple', note: 'Uncertainty principle — exam favourite',  daysAgo: 4 }),
        hl({ type: 'pdf_bbox',   page: 2, bbox: { x: 72, y: 480, width: 468, height: 22 }, color: 'amber', note: 'Schrödinger equation form', daysAgo: 2 }),
    ],
});

// ── Computer Science ──────────────────────────────────────────────────────────
console.log('\n── Computer Science / Algorithms ────────────────────────');

const dsCards = [
    card('What is the time complexity of binary search?', 'O(log n) — halves the search space each step; requires sorted input', { category: 'Concept', reviewCount: 5 }),
    card('What is the average-case time complexity of quicksort?', 'O(n log n); worst case O(n²) when the pivot is always the minimum or maximum element', { category: 'Concept', reviewCount: 4 }),
    flip('Stack', 'LIFO — push/pop at the same end; used in DFS, call stack, expression parsing, undo', { category: 'Definition', reviewCount: 3 }),
    flip('Queue', 'FIFO — enqueue at back, dequeue at front; used in BFS, task scheduling, buffers', { category: 'Definition', reviewCount: 3 }),
    cloze('A {{hash table}} maps keys to values via a hash function, providing O(1) average-case lookup, insert, and delete.', 'hash table', { category: 'Concept', reviewCount: 2 }),
    typed('What data structure does BFS use internally?', 'Queue', { category: 'Concept', reviewCount: 4 }),
    typed('What data structure does DFS use internally?', 'Stack (or the call stack via recursion)', { category: 'Concept', reviewCount: 3 }),
    card('Array vs linked list — when should you use each?', 'Array: O(1) random access, cache-friendly, fixed-size allocation. Linked list: O(1) insert/delete at known node, dynamic size, O(n) access.', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('Data Structures.md', 'Computer Science/Algorithms', `# Data Structures

## Complexity Reference
| Structure   | Access   | Search   | Insert   | Delete   | Space |
|-------------|----------|----------|----------|----------|-------|
| Array       | O(1)     | O(n)     | O(n)     | O(n)     | O(n)  |
| Linked List | O(n)     | O(n)     | O(1)*    | O(1)*    | O(n)  |
| Hash Table  | —        | O(1) avg | O(1) avg | O(1) avg | O(n)  |
| BST         | O(log n) | O(log n) | O(log n) | O(log n) | O(n)  |
| Heap        | O(1) max | O(n)     | O(log n) | O(log n) | O(n)  |

*at a known node

## Trees
- **BST**: left < root < right; O(log n) avg, O(n) worst-case (unbalanced)
- **AVL / Red-Black**: self-balancing; guarantee O(log n) worst-case
- **Heap**: complete binary tree; max-heap: every parent ≥ its children

## Graphs
Represented as adjacency list (sparse graphs) or adjacency matrix (dense graphs).

### Traversal
- **BFS** (Queue): finds shortest path in unweighted graphs
- **DFS** (Stack): topological sort, cycle detection, connected components
`, {
    globalHash: uuid(),
    tags: ['DataStructures'],
    flashcards: dsCards,
    highlights: [
        hl({ type: 'text_offset', start: 14, end: 95, color: 'amber', note: 'Complexity table — memorise for interviews', daysAgo: 6 }),
    ],
});

const sortCards = [
    flip('Merge Sort', 'Divide-and-conquer; O(n log n) all cases; stable; O(n) space — splits array in half, sorts halves, merges', { category: 'Concept', reviewCount: 3 }),
    flip('Heap Sort', 'Builds max-heap then extracts max repeatedly; O(n log n) all cases; O(1) extra space; not stable', { category: 'Concept', reviewCount: 2 }),
    cloze('Bubble sort has O({{n²}}) average and worst-case time complexity; it is only practical for nearly-sorted small arrays.', 'n²', { category: 'Symbol', reviewCount: 2 }),
    typed('What hybrid sorting algorithm do Python and V8 use?', 'Timsort (adaptive merge sort + insertion sort)', { category: 'Example', reviewCount: 1 }),
    card('What is the theoretical lower bound for comparison-based sorting?', 'Ω(n log n) — proven by decision-tree argument; any comparison sort needs at least this many comparisons in the worst case', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('Sorting Algorithms.md', 'Computer Science/Algorithms', `# Sorting Algorithms

## Comparison Sorts
| Algorithm | Best | Average | Worst | Space | Stable |
|-----------|------|---------|-------|-------|--------|
| Quicksort | O(n log n) | O(n log n) | O(n²) | O(log n) | No |
| Merge Sort | O(n log n) | O(n log n) | O(n log n) | O(n) | Yes |
| Heap Sort | O(n log n) | O(n log n) | O(n log n) | O(1) | No |
| Insertion | O(n) | O(n²) | O(n²) | O(1) | Yes |
| Bubble | O(n) | O(n²) | O(n²) | O(1) | Yes |

**Lower bound**: Ω(n log n) for any comparison-based sort (decision-tree proof).

## Non-Comparison Sorts
- **Counting Sort**: O(n+k) — integers in range [0, k]
- **Radix Sort**: O(d·n) — fixed-width integers or strings
- **Bucket Sort**: O(n) average — uniformly distributed data

## Practical Notes
- **Quicksort** dominates in practice: cache-friendly, O(log n) stack space
- **Timsort**: adaptive; exploits existing runs; used in Python, Java, V8
- **Insertion Sort**: optimal for n < ~10 (tiny constant factors)
`, {
    globalHash: uuid(),
    tags: ['Algorithms', 'Sorting'],
    flashcards: sortCards,
});

// ── Networking ────────────────────────────────────────────────────────────────
console.log('\n── Computer Science / Networking ────────────────────────');

const netCards = [
    card('What is the difference between TCP and UDP?', 'TCP: connection-oriented, reliable delivery, ordered, congestion-controlled — slower. UDP: connectionless, unreliable, no ordering — faster; for streaming, DNS, gaming.', { category: 'Concept', reviewCount: 4 }),
    card('What does DNS do?', 'Translates human-readable domain names (e.g. example.com) to IP addresses via a distributed hierarchical system', { category: 'Definition', reviewCount: 3 }),
    cloze('The {{OSI model}} has 7 layers: Physical, Data Link, Network, Transport, Session, Presentation, Application.', 'OSI model', { category: 'Concept', reviewCount: 2 }),
    flip('HTTP 200', 'OK — request succeeded; response body contains the resource', { category: 'Example', reviewCount: 3 }),
    flip('HTTP 404', 'Not Found — resource does not exist at the requested URI', { category: 'Example', reviewCount: 3 }),
    flip('HTTP 500', 'Internal Server Error — server encountered an unexpected condition', { category: 'Example', reviewCount: 2 }),
    typed('What port does HTTPS use by default?', '443  (HTTP is 80)', { category: 'Concept', reviewCount: 3 }),
];

await mkFile('Networking.md', 'Computer Science', `# Networking

Fundamentals of computer networking and the Internet.

## OSI Model (7 Layers)
| # | Layer | Protocol examples |
|---|-------|------------------|
| 7 | Application | HTTP, DNS, SMTP |
| 6 | Presentation | TLS/SSL, JPEG |
| 5 | Session | TLS handshake |
| 4 | Transport | TCP, UDP |
| 3 | Network | IP, ICMP |
| 2 | Data Link | Ethernet, Wi-Fi (MAC) |
| 1 | Physical | Cables, fiber, radio |

## TCP vs UDP
| Feature | TCP | UDP |
|---------|-----|-----|
| Connection | Yes (3-way handshake) | No |
| Reliability | Guaranteed (ACK + retransmit) | None |
| Ordering | Maintained | Not maintained |
| Use cases | HTTP, SSH, email | DNS, video streaming, gaming |

## HTTP Status Codes
- **2xx** Success — 200 OK, 201 Created, 204 No Content
- **3xx** Redirect — 301 Moved Permanently, 304 Not Modified
- **4xx** Client Error — 400 Bad Request, 401 Unauthorized, 404 Not Found
- **5xx** Server Error — 500 Internal Server Error, 503 Unavailable
`, {
    globalHash: uuid(),
    tags: ['Networking'],
    flashcards: netCards,
});

// ── Mathematics ───────────────────────────────────────────────────────────────
console.log('\n── Mathematics ──────────────────────────────────────────');

const calcCards = [
    card('What is the derivative of sin(x)?', 'cos(x)', { category: 'Symbol', reviewCount: 5 }),
    card('What is the derivative of eˣ?', 'eˣ — unchanged under differentiation', { category: 'Symbol', reviewCount: 5 }),
    card('State the chain rule.', "d/dx[f(g(x))] = f'(g(x)) · g'(x) — differentiate outer, multiply by derivative of inner", { category: 'Concept', reviewCount: 4 }),
    cloze('The {{Fundamental Theorem of Calculus}} links integration and differentiation: ∫ₐᵇ f(x)dx = F(b) − F(a) where F\' = f.', 'Fundamental Theorem of Calculus', { category: 'Concept', reviewCount: 3 }),
    typed('What is ∫x dx?', 'x²/2 + C', { category: 'Symbol', reviewCount: 4 }),
    flip('Product Rule', "d/dx[f·g] = f'g + fg'", { category: 'Concept', reviewCount: 2 }),
    flip('Quotient Rule', "d/dx[f/g] = (f'g − fg') / g²", { category: 'Concept', reviewCount: 2 }),
    card("What is L'Hôpital's rule?", "For indeterminate forms 0/0 or ∞/∞: lim f(x)/g(x) = lim f'(x)/g'(x)", { category: 'Concept', reviewCount: 1 }),
];

await mkFile('Calculus.md', 'Mathematics', `# Calculus

Differential and integral calculus — the mathematics of continuous change.

## Key Derivatives
| f(x) | f\'(x) |
|------|--------|
| xⁿ | n·xⁿ⁻¹ |
| sin x | cos x |
| cos x | −sin x |
| eˣ | eˣ |
| ln x | 1/x |
| aˣ | aˣ·ln a |

## Differentiation Rules
- **Power**: d/dx[xⁿ] = nxⁿ⁻¹
- **Sum**: (f+g)' = f' + g'
- **Product**: (fg)' = f'g + fg'
- **Quotient**: (f/g)' = (f'g − fg') / g²
- **Chain**: d/dx[f(g(x))] = f'(g(x))·g'(x)

## Integration
- **FTC**: ∫ₐᵇ f(x)dx = F(b) − F(a)
- **By parts**: ∫u dv = uv − ∫v du
- **Substitution**: let u = g(x), ∫f(g(x))g'(x)dx = ∫f(u)du
`, {
    globalHash: uuid(),
    tags: ['Calculus'],
    flashcards: calcCards,
});

const laCards = [
    flip('Matrix multiplication', 'C = A·B where Cᵢⱼ = Σₖ Aᵢₖ·Bₖⱼ; defined only when cols(A) = rows(B)', { category: 'Concept', reviewCount: 3 }),
    card('det([[a,b],[c,d]]) = ?', 'ad − bc; non-zero iff the matrix is invertible', { category: 'Symbol', reviewCount: 3 }),
    card('What does linear independence mean?', 'No vector in the set is a linear combination of the others; the only solution to Σcᵢvᵢ = 0 is all cᵢ = 0', { category: 'Definition', reviewCount: 2 }),
    cloze('An {{eigenvalue}} λ satisfies Av = λv, where eigenvector v ≠ 0 is a direction unchanged by transformation A.', 'eigenvalue', { category: 'Concept', reviewCount: 2 }),
    typed('What does the identity matrix I do to a vector v?', 'Returns it unchanged: Iv = v', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('Linear Algebra.md', 'Mathematics', `# Linear Algebra

Vectors, matrices, and linear transformations.

## Vector Spaces
A set V closed under vector addition and scalar multiplication.
- **Basis**: linearly independent spanning set
- **Dimension**: number of basis vectors
- **Span**: all linear combinations of the basis vectors

## Matrices
Rectangular arrays representing linear transformations.

### Key Operations
- **Transpose**: Aᵀ — rows become columns
- **Inverse**: A·A⁻¹ = I (only for square, non-singular matrices)
- **Determinant**: det(A) ≠ 0 ↔ A is invertible ↔ rows/cols are linearly independent

### Eigenvalues and Eigenvectors
**Av = λv**  where v ≠ 0

Find λ from characteristic polynomial: **det(A − λI) = 0**

## Applications
- Computer graphics: transformations, projections
- Machine learning: PCA (Principal Component Analysis), SVD
- Physics: vibration modes, quantum mechanics operators
`, {
    globalHash: uuid(),
    tags: ['LinearAlgebra'],
    flashcards: laCards,
});

// ── Humanities ────────────────────────────────────────────────────────────────
console.log('\n── Humanities ───────────────────────────────────────────');

const wwiiCards = [
    card('When did WWII begin and end?', 'Began September 1, 1939 (Germany invaded Poland); ended September 2, 1945 (Japan signed surrender)', { category: 'Concept', reviewCount: 4 }),
    card('What was D-Day?', 'June 6, 1944 — Allied amphibious invasion of Normandy, France (Operation Overlord); largest seaborne invasion in history', { category: 'Definition', reviewCount: 4 }),
    cloze('The {{Manhattan Project}} (1942–45) was the Allied program that developed nuclear weapons; led by J. Robert Oppenheimer at Los Alamos.', 'Manhattan Project', { category: 'Concept', reviewCount: 3 }),
    flip('Blitzkrieg', "German strategy: rapid coordinated armoured + air attacks to overwhelm defenders before they can organize; literally 'lightning war'", { category: 'Terminology', reviewCount: 2 }),
    typed('Who was the Allied Supreme Commander in Europe?', 'General Dwight D. Eisenhower', { category: 'Concept', reviewCount: 3 }),
    card('What were the Big Three Allied powers?', 'United States, United Kingdom, and the Soviet Union', { category: 'Concept', reviewCount: 2 }),
];

await mkFile('World War II.md', 'Humanities/History', `# World War II (1939–1945)

The global conflict that reshaped the modern world.

## Key Theaters
| Theater | Powers | Turning Point |
|---------|--------|---------------|
| Western Europe | Germany vs UK/US/France | D-Day (June 1944) |
| Eastern Front | Germany vs USSR | Stalingrad (1942–43) |
| Pacific | Japan vs USA | Midway (1942) |
| North Africa | Axis vs Allies | El Alamein (1942) |

## Major Turning Points
1. **Battle of Britain** (1940) — RAF denied Germany air superiority
2. **Battle of Stalingrad** (1942–43) — decisive Soviet victory; 800,000 Axis casualties
3. **D-Day** (June 6, 1944) — Allied liberation of Western Europe begins
4. **Atomic bombs** (Aug 1945) — Hiroshima and Nagasaki → Japanese surrender

## Aftermath
- 70–85 million dead (~3% of world population)
- United Nations established 1945
- Cold War begins between USA and USSR
- Nuremberg Trials (1945–46) — established crimes against humanity
`, {
    globalHash: uuid(),
    tags: ['WWII', 'ModernHistory'],
    flashcards: wwiiCards,
});

const romeCards = [
    card('What were the three main periods of Roman history?', 'Kingdom (753–509 BC) → Republic (509–27 BC) → Empire (27 BC–476 AD)', { category: 'Concept', reviewCount: 3 }),
    flip('Pax Romana', "~200-year period of relative peace in the Roman Empire (27 BC – 180 AD) beginning with Augustus; Rome's golden age", { category: 'Definition', reviewCount: 2 }),
    cloze("Julius Caesar was assassinated on the {{Ides of March}} (March 15, 44 BC) by senators including Brutus and Cassius.", 'Ides of March', { category: 'Concept', reviewCount: 2 }),
    typed('Who was the first Roman Emperor?', 'Augustus (Octavian), ruled 27 BC – 14 AD', { category: 'Concept', reviewCount: 2 }),
    card("What was the Roman Republic's Senate?", 'Legislative and advisory body of ~300 patrician senators; controlled finances, foreign policy, and provincial governance', { category: 'Concept', reviewCount: 1 }),
];

await mkFile('Ancient Rome.md', 'Humanities/History', `# Ancient Rome

From city-state to Mediterranean empire.

## Timeline
- **753 BC** — Traditional founding by Romulus
- **509 BC** — Republic established (kings expelled)
- **264–146 BC** — Punic Wars vs. Carthage; Rome dominates Mediterranean
- **44 BC** — Assassination of Julius Caesar
- **27 BC** — Augustus becomes first emperor; Republic ends
- **Pax Romana** — 27 BC to 180 AD; height of imperial power
- **476 AD** — Fall of Western Rome

## Republic Government
- **Senate** (300 patricians): controlled finances and foreign policy
- **Consuls** (2, elected annually): ran government and commanded armies
- **Tribunes**: protected plebeian interests; had veto power (intercessio)

## Legacy
Roman law, Latin language, engineering (roads, aqueducts), and Christianity as state religion shaped Western civilization for millennia.
`, {
    globalHash: uuid(),
    tags: ['AncientHistory', 'Rome'],
    flashcards: romeCards,
});

const epistCards = [
    card('What is epistemology?', 'The branch of philosophy concerned with the nature, sources, scope, and limits of human knowledge', { category: 'Definition', reviewCount: 2 }),
    flip('Rationalism', 'Knowledge comes primarily from reason and innate ideas — independent of sensory experience (Descartes, Leibniz, Spinoza)', { category: 'Concept', reviewCount: 2 }),
    flip('Empiricism', 'Knowledge derives entirely from sensory experience; mind begins as blank slate — tabula rasa (Locke, Hume, Berkeley)', { category: 'Concept', reviewCount: 1 }),
    cloze("Descartes' {{cogito ergo sum}} ('I think, therefore I am') is the bedrock of his rationalist epistemology — the one claim he could not doubt.", 'cogito ergo sum', { category: 'Concept', reviewCount: 1 }),
];

await mkFile('Epistemology.md', 'Humanities/Philosophy', `# Epistemology

The theory of knowledge: what we know, how we know it, and the limits of knowing.

## Central Questions
- What is knowledge? (justified true belief — or something more?)
- What are the sources of knowledge?
- What can we not know, and why?

## Main Traditions

### Rationalism
Knowledge is grounded in reason and innate ideas, prior to and independent of experience.
- **Descartes**: *Cogito ergo sum* — doubted everything until finding bedrock certainty in thinking
- **Leibniz**: pre-established harmony, innate ideas
- **Spinoza**: deduction from self-evident axioms

### Empiricism
Knowledge comes from sensory experience; the mind is a blank slate (*tabula rasa*).
- **Locke**: primary vs secondary qualities; representative realism
- **Hume**: skepticism about causation and personal identity
- **Berkeley**: *esse est percipi* — "to be is to be perceived"

## Justified True Belief (JTB)
Classical definition of knowledge: a belief that is (1) true, (2) believed, (3) justified.
**Gettier problems** (1963) showed JTB is not sufficient for knowledge.
`, {
    globalHash: uuid(),
    tags: ['Philosophy', 'Epistemology'],
    flashcards: epistCards,
});

// ---------------------------------------------------------------------------
// ── STEP 3: Folder tags — bottom-up so parent propagation reads correct sidecars
// ---------------------------------------------------------------------------

console.log('\n── Applying folder tags (bottom-up for correct propagation) ──');

// Science branch — Microbiology excludes STEM
await setFolderTags('Science/Biology/Microbiology', ['Microbiology'], ['STEM']);
await setFolderTags('Science/Biology',              ['Biology']);
await setFolderTags('Science/Physics',              ['Physics']);
await setFolderTags('Science',                      ['Science', 'STEM']);   // triggers full Science propagation

// CS branch
await setFolderTags('Computer Science/Algorithms', ['Algorithms']);
await setFolderTags('Computer Science',            ['CS', 'STEM', 'Programming']);

// Math
await setFolderTags('Mathematics', ['Math', 'STEM']);

// Humanities branch — Philosophy excludes Humanities
await setFolderTags('Humanities/Philosophy', ['Philosophy'], ['Humanities']);
await setFolderTags('Humanities/History',    ['History']);
await setFolderTags('Humanities',            ['Humanities']);               // triggers full Humanities propagation

// ---------------------------------------------------------------------------
// ── STEP 4: Decks ────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

console.log('\n── Creating decks and populating entries ────────────────');

const deckScience = mkDeck(
    'Science Fundamentals',
    'Core biology, genetics, and physics concepts for a solid science foundation.'
);
const deckCS = mkDeck(
    'CS Interview Prep',
    'Data structures, algorithms, and networking essentials for technical interviews.'
);
const deckMath = mkDeck(
    'Math Core',
    'Calculus and linear algebra concepts essential for engineering and data science.'
);
const deckDaily = mkDeck(
    'Daily Review',
    'Curated high-priority mix across all subjects for a focused 15-minute session.'
);

// Science Fundamentals: top cards from bio + genetics + mechanics
let n = populateDeck(deckScience, [
    ...cellBioCards.slice(0, 3).map(c => ({ c, docPath: 'Science/Biology/Cell Biology.md' })),
    ...geneticsCards.slice(0, 3).map(c => ({ c, docPath: 'Science/Biology/Genetics.md' })),
    ...mechCards.slice(0, 4).map(c => ({ c, docPath: 'Science/Physics/Classical Mechanics.md' })),
]);
console.log(`  "Science Fundamentals"  — ${n} entries`);

// CS Interview Prep: DS + sorting + networking
n = populateDeck(deckCS, [
    ...dsCards.slice(0, 4).map(c => ({ c, docPath: 'Computer Science/Algorithms/Data Structures.md' })),
    ...sortCards.slice(0, 3).map(c => ({ c, docPath: 'Computer Science/Algorithms/Sorting Algorithms.md' })),
    ...netCards.slice(0, 3).map(c => ({ c, docPath: 'Computer Science/Networking.md' })),
]);
console.log(`  "CS Interview Prep"     — ${n} entries`);

// Math Core: calculus + LA
n = populateDeck(deckMath, [
    ...calcCards.slice(0, 5).map(c => ({ c, docPath: 'Mathematics/Calculus.md' })),
    ...laCards.slice(0, 3).map(c => ({ c, docPath: 'Mathematics/Linear Algebra.md' })),
]);
console.log(`  "Math Core"             — ${n} entries`);

// Daily Review: 2 top cards from each subject area
n = populateDeck(deckDaily, [
    ...cellBioCards.slice(0, 2).map(c => ({ c, docPath: 'Science/Biology/Cell Biology.md' })),
    ...mechCards.slice(0, 2).map(c => ({ c, docPath: 'Science/Physics/Classical Mechanics.md' })),
    ...quantumCards.slice(0, 2).map(c => ({ c, docPath: 'Science/Physics/Quantum Mechanics.md' })),
    ...dsCards.slice(0, 2).map(c => ({ c, docPath: 'Computer Science/Algorithms/Data Structures.md' })),
    ...calcCards.slice(0, 2).map(c => ({ c, docPath: 'Mathematics/Calculus.md' })),
    ...wwiiCards.slice(0, 2).map(c => ({ c, docPath: 'Humanities/History/World War II.md' })),
]);
console.log(`  "Daily Review"          — ${n} entries`);

// ---------------------------------------------------------------------------
// ── STEP 5: Review history — seed Leitner levels 1–5 ─────────────────────────
// ---------------------------------------------------------------------------

console.log('\n── Seeding review history ───────────────────────────────');

// Session history templates per target level
const sessionsByLevel = {
    5: [
        { daysAgo: 45, outcome: 'again', easeFactor: 2.5, level: 0 },
        { daysAgo: 42, outcome: 'hard',  easeFactor: 2.3, level: 1 },
        { daysAgo: 38, outcome: 'good',  easeFactor: 2.5, level: 2 },
        { daysAgo: 30, outcome: 'good',  easeFactor: 2.5, level: 3 },
        { daysAgo: 18, outcome: 'easy',  easeFactor: 2.7, level: 4 },
        { daysAgo:  4, outcome: 'easy',  easeFactor: 2.9, level: 5 },
    ],
    4: [
        { daysAgo: 28, outcome: 'again', easeFactor: 2.5, level: 0 },
        { daysAgo: 25, outcome: 'good',  easeFactor: 2.5, level: 1 },
        { daysAgo: 20, outcome: 'good',  easeFactor: 2.5, level: 2 },
        { daysAgo:  9, outcome: 'easy',  easeFactor: 2.7, level: 4 },
    ],
    3: [
        { daysAgo: 18, outcome: 'hard',  easeFactor: 2.3, level: 0 },
        { daysAgo: 15, outcome: 'good',  easeFactor: 2.5, level: 1 },
        { daysAgo:  7, outcome: 'good',  easeFactor: 2.5, level: 3 },
    ],
    2: [
        { daysAgo: 10, outcome: 'again', easeFactor: 2.5, level: 0 },
        { daysAgo:  6, outcome: 'good',  easeFactor: 2.5, level: 2 },
    ],
    1: [
        { daysAgo: 2, outcome: 'hard', easeFactor: 2.3, level: 1 },
    ],
};

// Map cards → target level
const reviewPlan = [
    { cards: [cellBioCards[0], mechCards[0], mechCards[1], dsCards[0], calcCards[0], calcCards[1]],          targetLevel: 5 },
    { cards: [cellBioCards[1], geneticsCards[0], mechCards[2], dsCards[1], calcCards[2], netCards[0]],       targetLevel: 4 },
    { cards: [cellBioCards[2], geneticsCards[1], quantumCards[0], dsCards[2], dsCards[3], calcCards[3]],     targetLevel: 3 },
    { cards: [geneticsCards[2], bacteriaCards[0], quantumCards[1], sortCards[0], laCards[0], wwiiCards[0]],  targetLevel: 2 },
    { cards: [cellBioCards[3], bacteriaCards[1], mechCards[3], netCards[3], calcCards[4], romeCards[0]],     targetLevel: 1 },
];

let reviewsAdded = 0;

for (const { cards: planCards, targetLevel } of reviewPlan) {
    const sessions = sessionsByLevel[targetLevel];
    for (const fc of planCards) {
        const dbCard = query.getFlashcardByHash(fc.globalHash);
        if (!dbCard) continue;

        for (const s of sessions) {
            try {
                query.insertReviewLog({
                    flashcardId: dbCard.id,
                    timestamp:   pastDate(s.daysAgo),
                    outcome:     s.outcome,
                    easeFactor:  s.easeFactor,
                    level:       s.level,
                });
                reviewsAdded++;
            } catch (_) {}
        }

        const last = sessions[sessions.length - 1];
        query.updateFlashcardReview(dbCard.id, pastDate(last.daysAgo), targetLevel);
    }
}

console.log(`  ${reviewsAdded} review log entries inserted`);

// ---------------------------------------------------------------------------

const totalCards =
    cellBioCards.length + geneticsCards.length + bacteriaCards.length +
    mechCards.length + quantumCards.length +
    dsCards.length + sortCards.length + netCards.length +
    calcCards.length + laCards.length +
    wwiiCards.length + romeCards.length + epistCards.length;

console.log(`
Seed complete.

  Folders    10  nested across Science, CS, Mathematics, Humanities
  Files      13  markdown documents
  Cards      ${totalCards}  all 5 types (basic, reversible, cloze, type_answer, custom)
             all 6 categories (Definition, Terminology, Symbol, Concept, Example, Exercise)
  Highlights  5  (text_offset + pdf_bbox, amber / blue / green / purple)
  Decks       4  Science Fundamentals / CS Interview Prep / Math Core / Daily Review
  Reviews    ${reviewsAdded}  Leitner levels 1-5 seeded

Tag inheritance:
  Science/ [Science, STEM]
    Biology/ [Biology]                   inherits Science, STEM
      Cell Biology.md                    inherits Science, STEM, Biology
      Genetics.md                        inherits Science, STEM, Biology
      Microbiology/ [Microbiology]  excl:STEM
        Bacteria & Viruses.md            inherits Science, Biology, Microbiology  (no STEM)
    Physics/ [Physics]                   inherits Science, STEM
      Classical Mechanics.md             inherits Science, STEM, Physics
      Quantum Mechanics.md               inherits Science, STEM, Physics
  Computer Science/ [CS, STEM, Programming]
    Algorithms/ [Algorithms]             inherits CS, STEM, Programming
      Data Structures.md                 inherits CS, STEM, Programming, Algorithms
      Sorting Algorithms.md              inherits CS, STEM, Programming, Algorithms
    Networking.md                        inherits CS, STEM, Programming
  Mathematics/ [Math, STEM]
    Calculus.md                          inherits Math, STEM
    Linear Algebra.md                    inherits Math, STEM
  Humanities/ [Humanities]
    History/ [History]                   inherits Humanities
      World War II.md                    inherits Humanities, History
      Ancient Rome.md                    inherits Humanities, History
    Philosophy/ [Philosophy]        excl:Humanities
      Epistemology.md                    inherits Philosophy  (no Humanities)
`);
