# Flashback Data Model Specification

The Flashback system maintains data in **two synchronized layers**:

1. **Canonical Data Layer**

   - Stored as `.flashback` files in the user’s file tree.
   - Human-readable JSON format (hidden by default for convenience).
   - Serves as the _source of truth_ for documents, annotations, flashcards, tags, and media references.
   - Designed for portability, packaging, and sharing of study materials.
2. **Derived Data Layer**

   - Stored in a **SQLite database** at `{vaultName}/{vaultName}.db` inside the active vault directory.
   - Optimized for fast querying and consumption by the Flashback API.
   - Contains normalized and indexed representations of canonical data (flashcards, tags, review logs, presence metrics).

---

## Vault Structure

All user data is scoped to a **vault** — a named, self-contained directory. An install may hold several; `config.json` carries a `vaults[]` registry and an `activeVaultId` pointer, and keeps the flat `vaultName`/`isCustomPath`/`customPath` fields as the projection of whichever vault is active. Both data layers for a given vault live inside it.

```
{baseDir}/                        ← app data directory (or customPath if configured)
  config.json                     ← server configuration + vault/remote registries; outside vaults
  accounts.db                     ← accounts, roles and token hashes; outside vaults (see § Accounts)
  {vaultName}/                    ← vault root, e.g. dreams/
    vault.json                    ← vault identity (a stable UUID); NOT versioned by Seal
    workspace/                    ← canonical layer root (.flashback sidecars and documents)
    {vaultName}.db                ← derived layer (SQLite), e.g. dreams.db
    diary/                        ← per-day study record, its own git repo (see § Diary)
```

### Vault identity — `vault.json`

```json
{ "id": "<uuid>", "name": "dreams", "createdAt": "<iso>", "manifestVersion": 1 }
```

`id` is the only field anything should key on. It survives renaming the folder, moving it to another disk, or copying it to another machine — none of which the vault *name* survives, and none of which the derived database can be trusted through, since it is rebuildable by definition.

It sits at the vault root rather than inside `workspace/` on purpose. `workspace/` is the Seal git repo, and a vault's identity is not something to version, roll back, or read out of a diff; keeping it outside also means `UpdateRunner`'s workspace walk never sees it, so it needs no `formatVersion` of its own. `manifestVersion` moves only if this file's own shape changes, and is unrelated to the sidecar `formatVersion` ladder.

`ensureManifest()` is idempotent and runs on every vault open, which is how vaults created before manifests existed acquire an id — on their next launch, with no migration and no schema change.

**A copied vault keeps its id.** That is intended: two copies of the same vault are the same vault as far as a future sync is concerned, and telling them apart is a job for whatever compares their histories, not for the identity itself.

`baseDir` resolves to `app.getPath(‘userData’)` in the Electron process and is passed to the API as the `USER_DATA_PATH` environment variable — which the config resolver honours wherever it is set, Electron or not. Renaming a vault updates its registry entry and moves the vault directory **and** the `{vaultName}.db` inside it together, then re-derives the index so the stored `absolute_path` columns stop pointing at the old folder. The `workspace/` subdirectory is the root of the Seal git repository.

---

## Canonical File Structure

Every project (e.g., a course) is organized in a regular directory tree. Each folder and file may have an associated `.flashback` file storing metadata and flashcard data.

**Example: raw file tree**Inteligencia_Artificial

├── Clase060824.ipynb
├── clase070824.ipynb
├── datasets
│   └── breast_cancer_data.pdf

**Example: file tree with `.flashback` data**

```
wwwInteligencia_Artificial
├── .flashback                        # folder-level metadata
├── Clase060824.ipynb
├── Clase060824.ipynb.flashback       # flashcards + metadata for this file
├── clase070824.ipynb
├── clase070824.ipynb.flashback
├── notes
│   ├── .flashback
│   ├── breast_cancer_data.pdf
│   └── breast_cancer_data.pdf.flashback
```

### Canonical file versioning

Every canonical file — folder sidecar, file sidecar, and `_decks/*.json` — carries a
**`formatVersion`** integer saying which canonical updates it has been through:

```json
{ "formatVersion": 1, "globalHash": "…", "tags": [] }
```

This is the canonical layer's equivalent of `SchemaVersion`, but recorded **per file** rather
than once per vault, and that is deliberate. A canonical file can arrive from anywhere — a
backup, another machine, a Seal rollback to a commit from a year ago — so it has to be
self-describing: `config/UpdateRunner.js` reads the stamp, applies only the updates that file
still needs, and stamps the new version. A file with no `formatVersion` is version 0.

The `CanonicalVersion` table records what the *vault* has finished, purely so a normal
startup skips the walk. Full spec, including the rules an update must follow, in
`src/api/config/updates/UPDATES.md`.

### `createdBy` 

Every sidecar records who created it. The value is a **git author line** — `Name <email>` —
resolved from the local user identity (below) at the moment the file is created:

```json
{ "createdBy": "Daniel <daniel@example.com>", "createdAt": "2026-08-17T…" }
```

It is written once and **never rewritten**: every write site is `metadata.createdBy || …`,
so an edit, a move, or a canonical update leaves it exactly as it was. That is what makes it
provenance — a claim about the past, which a later change of identity does not falsify.

**A reader must tolerate three shapes.** Files created before this existed carry the *vault
name* (`"dreams"`, `"work"`), because that was what the stamp reached for when there was no
concept of a person; those are deliberately left alone rather than backfilled. Files created
since carry `Name <email>`. A file that arrives from a Flashback Server will carry whatever
that server stamped. Nothing in the app parses the field or resolves it to anyone, and
nothing should authorize on it — it is self-asserted text, and on a remote it is text a
client asserted. Identity resolution is the future `Users` table's job, not this field's.

### Local user identity — `config.json`

Who this install stamps work as, in git's terms. One `user` key, outside any vault:

```jsonc
{
  "user": {
    "name":  "Daniel",
    "email": "daniel@example.com",
    "perVault": {                                  // optional, keyed by vault id
      "<vault-uuid>": { "name": "D. Pineda", "email": "d@acme.example" }
    }
  }
}
```

Resolution (`access/primitives/config.js` — `getIdentity()`, `getAuthorString()`) is
`user.perVault[activeVaultId]` → `user` → derived from the OS account
(`<osuser>@flashback.local`). A pair only counts when **both** halves are non-empty; a name
with no address cannot produce an author line, so a half-filled entry falls through instead
of yielding `Daniel <>`. There is always an answer, because unlike git the app cannot refuse
to write a file for want of one.

Two consumers, and they are deliberately the same value so a file and the commit that
created it cannot disagree about who made them: a new sidecar's `createdBy`, and the Seal
commit author.

The per-vault override lives under `user`, **not** on the `vaults[]` registry entry and
**not** in `vault.json`: "which address I use where" is a fact about the person, and it must
not travel with a copied vault folder to someone else's machine. Keying by vault id rather
than by name also means renaming a vault does not orphan its override.

It is asked for once, in the setup wizard's identity step, and editable afterwards in
Config. Skipping the step writes no `user` key rather than storing the derived default as
though it were chosen — the resolved value is identical either way, but `source` then
honestly reports `default`.

**This is not authentication.** Nothing validates the name or the address and nothing gates
on either. Writes are Electron-IPC-only (main owns the `user` key, as it owns `apiToken`,
`vaults[]` and `remotes[]`, and `set-config` preserves it from disk so a stale renderer form
cannot clobber it); `GET /api/identity` is read-only and exists so the MCP server
and a `dev:web` session can show whose work they are looking at. What authorizes a *remote*
is its access token, a separate mechanism entirely.

### Folder-level `.flashback` file

- Contains metadata and tags inherited by all files and flashcards within the folder.
- Example:

```json
{
  "formatVersion": 1,
  "globalHash": "unique-folder-hash", # A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Artificial Intelligence", "Course", "Fall 2024"],
}

```

### File-level `.flashback` file

- Contains metadata and flashcards for the specific file.
- Example:

```json
{
  "formatVersion": 1,
  "globalHash": "unique-file-hash",# A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Lecture", "KNN"],
  "excludedTags": ["AI"],
  "highlights": [
    {
      "id": "h_3f9a1c0b2",            # stable per-document id
      "color": "amber",              # amber | green | blue | pink — maps to --color-hl-* theme vars
      "text": "K-Nearest Neighbors", # snapshot of the highlighted text (list views + re-anchoring)
      "start": 412,                  # plain text (.txt) only: character offsets into the body
      "end": 433,                    # (absent for markdown, which anchors inline instead)
      "createdAt": "2025-09-14T15:30:00Z",
      "updatedAt": "2025-09-14T15:30:00Z",
      "cardHashes": [],              # flashcards anchored to this highlight (optional)
      "refIds": []                   # reserved for future reference links
    }
  ],
  # Highlight anchoring differs by document type:
  #   • Markdown — stored inline in the body as <mark data-color data-hl>; the
  #     entry above mirrors it (no start/end). Survives edits to surrounding text.
  #     A registry entry with no inline mark (created out-of-band — e.g. the MCP
  #     server's create_highlight, which writes only the sidecar) is re-anchored
  #     on load by searching the rendered text for its `text` snapshot; once the
  #     document is saved the mark is serialized into the body and becomes native.
  #   • Plain text (.txt) — the body stays pure text, so the entry carries
  #     start/end character offsets. Offsets are tracked live while editing and
  #     re-anchored against `text` on load if the file changed out of band.
  "flashcards": [
    {
      "name": "optional descriptive name",
      "globalHash": "identifier",
      "lastRecall": "2025-09-14T15:30:00Z",
      "level": 6,
      "easeFactor": 0.45,
      "presence": 0.57,
      "tags": ["Definition", "Supervised Learning"],
      "category": "Concept",
      "cardType": "basic",
      "origin": "ai",                # provenance: present + 'ai' = AI-created (MCP); absent = handmade
      "customData": { "html": "" },
      "vanillaData": {
        "frontText": "What is KNN?",
        "backText": "K-Nearest Neighbors algorithm",
        "media": {
          "front_img": "sha256hash",
          "back_img": "sha256hash",
          "front_sound": "sha256hash",
          "back_sound": "sha256hash"
        },
        "location": {"type": "pdf_location", "data": {"page": 12, "bbox": [100, 200, 400, 250]}}
      }
    }
  ]
}

```

---

### Reference examples

Reference data varies from the types of documents, so the data might change according to the document. Reference values indicate on which part of the document references the flashcard

- **Markdown / Text Documents (preferred):**
  - `{"type": "highlight", "id": "h_3f9a1c0b2"}`
    (anchors to a highlight in the document's `highlights[]`; the highlight is stored
    inline as a `<mark data-hl="...">` so it survives edits to surrounding text)
- **Text Documents (legacy):**
  - `{"type": "text_offset", "data": {"start": 123, "end": 150}}`
    (character offsets; fragile — shifts when the document is edited. Superseded by `highlight`.)
- **PDFs / clips / videos (preferred = highlight-anchored):**
  - In practice these formats also use `{"type": "highlight", "id": "..."}`; the
    anchor geometry lives on the highlight registry entry, not the card. The
    highlight's own `type` encodes the strategy (see below). The legacy direct
    forms `{"type": "pdf_location"|"video_timestamp", "data": {...}}` are still
    accepted by `FlashcardReference` but the UI no longer emits them.

**Highlight anchor types** (the `type` field on each `highlights[]` entry / the
`Highlights.type` column — free-text, no migration needed to add more):

| `type`            | Producer                     | Position encoding                                                               |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| `text_offset`     | `.txt` (default)           | `start`/`end` char offsets, `text` snapshot fallback                      |
| *(inline)*        | Markdown                     | `<mark data-hl>` in the body; no offsets                                      |
| `pdf_bbox`        | `PdfRenderer`              | `page` + `bbox {x,y,width,height}` in PDF units (scale=1)                   |
| `clip_range`      | `ClipRenderer` (web clips) | `start`/`end` char offsets into rendered `textContent`, `text` fallback |
| `video_timestamp` | `YoutubeRenderer`          | `start`/`end` in **seconds** into the video                           |

## Flashcard Types

Every flashcard has a `cardType` field (stored as `card_type TEXT NOT NULL DEFAULT 'basic'` in the DB). The type drives both the renderer and the form fields used to create or edit the card.

| `cardType`    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic`       | Standard two-sided flip. Front and back are independent text + media blocks.                                                                                                                                                                                                                                                                                                                                                                 |
| `reversible`  | Same data as basic, but direction (`forward` / `reverse`) is randomised per session so the card tests in both directions.                                                                                                                                                                                                                                                                                                                |
| `cloze`       | Text with`{{blank}}` markers. Front shows underlined gaps; back reveals the filled words highlighted in amber. Both sides share the same `frontText` (stored in `vanillaData.frontText` and `vanillaData.backText`).                                                                                                                                                                                                                 |
| `type_answer` | Question in`frontText`; expected answer in `answerText`; optional post-review notes in `backText`. The front face shows an inline text input + Check button. The Trainer compares the typed value to **`answerText` only** (case-insensitive trim) and shows a correct/wrong verdict before grading; the back then shows the answer with the notes underneath, so a card can carry a mnemonic without changing what is graded. |
| `custom`      | Full HTML stored in`customData.html`. Rendered in a sandboxed `<iframe srcdoc>` (no network access). `vanillaData` fields are unused and kept empty.                                                                                                                                                                                                                                                                                   |

### Sidecar representation per type

```json
// basic / reversible
{
  "cardType": "basic",
  "vanillaData": { "frontText": "Question", "backText": "Answer",
                   "media": { "front_img": "hash", "back_img": "hash",
                              "front_sound": "hash", "back_sound": "hash" } },
  "customData": { "html": "" }
}

// cloze
{
  "cardType": "cloze",
  "vanillaData": { "frontText": "The {{mitochondria}} is the {{powerhouse}}.",
                   "backText":  "The {{mitochondria}} is the {{powerhouse}}.",
                   "media": { "front_img": null, "back_img": null,
                              "front_sound": null, "back_sound": null } },
  "customData": { "html": "" }
}

// type_answer
{
  "cardType": "type_answer",
  "vanillaData": { "frontText":  "What is the capital of France?",
                   "answerText": "Paris",
                   "backText":   "On the Seine; capital since 987.",
                   "media": { "front_img": null, "back_img": null,
                              "front_sound": null, "back_sound": null } },
  "customData": { "html": "" }
}

// custom
{
  "cardType": "custom",
  "vanillaData": { "frontText": "", "backText": "", "media": {} },
  "customData": { "html": "<div style='font-size:24px'>Custom content</div>" }
}
```

### Media references

All media slots (`front_img`, `back_img`, `front_sound`, `back_sound`) store a **SHA-256 hash string**, not a file path. The hash is resolved at runtime via `GET /api/media?hash=<hash>`. The `Media` table maps hashes to absolute paths on disk. All non-custom card types support the four media slots.

### Backward compatibility

Sidecars written before `cardType` was introduced may carry `"isCustom": true` instead of `"cardType"`. The renderer resolves this with: `card.cardType ?? (card.isCustom ? 'custom' : 'basic')`.

A `type_answer` card written before `answerText` existed keeps its expected answer in `backText` and has no `answerText` key at all. Readers resolve this with one rule — **the compared value is `answerText`, falling back to `backText` when it is absent or empty; notes exist only when `answerText` does** — implemented once per side in `typeAnswerParts()` (`src/ui/components/shared/flashcardFields.js`) and `answerBody()` (`access/orchestration/cardHealth.js`).

Vaults are migrated to the new shape by **canonical update 001** (`config/updates/001_type_answer_split.js` — sidecars + `_decks/*.json`, sealed as one `reconcile:` commit) and its paired schema migration 008 (the `FlashcardContent.answerText` column and its backfill). The fallback is kept regardless: a Seal rollback can restore a pre-split sidecar at any time, so correctness never depends on the update having run.

Compatibility runs **forwards only**. The rule above lets a current build read a pre-split card; it cannot help a build released *before* `answerText`, which has no such rule to apply. Such a build still opens a migrated vault and reviews every other card type, but grades `type_answer` against the now-empty `backText` (unanswerable), and its standalone-card writer drops `answerText` entirely on the next edit. See `config/updates/UPDATES.md` § One-way updates and the downgrade warning in `CHANGELOG.md`.

---

## Tagging and Categorization

Flashback supports two complementary metadata systems:

1. **Tags**

   - Can be applied at folder, file, or flashcard level.
   - Tags propagate downward (inheritance), creating implicit relationships between items across the tree.
   - This allows cross-cutting connections beyond strict file hierarchy (e.g., two unrelated flashcards both tagged `"Linear Algebra"`).
2. **Categories**

   - Define the pedagogical role of a flashcard.
   - Default categories, grouped by priority:| Priority | Category        | Description                                    |
     | -------- | --------------- | ---------------------------------------------- |
     | 0        | `Definition`  | The definition of a word or concept            |
     | 0        | `Terminology` | The usage of a word                            |
     | 0        | `Symbol`      | The usage of symbols                           |
     | 1        | `Concept`     | An abstract idea                               |
     | 1        | `Example`     | Examples of usage                              |
     | 2        | `Exercise`    | Apply knowledge in a practical task or problem |
     | 2        | `Procedure`   | Execute a method or algorithm step by step     |
   - Lower priority number = reviewed first. Categories are seeded at startup via `DefaultData.js`.

---

## Media Organization

- Each folder maintains its own media directory, scoped to that folder’s `.flashback` and flashcards. Markdown and html documents may access this folder to reference media files, but the scope of the support it's only trough the flasback frontend
- Each flashback directory is meant for self-contained packaging is meant to translate folder data structures to courses for sharing
- Example layout:

```
Inteligencia_Artificial
├── .flashback
├── Clase060824.ipynb
├── Clase060824.ipynb.flashback
├── media
│   ├── front.png
│   ├── back.png
│   └── sound.mp3

```

## Access Module Hierarchy

All data operations flow through `src/api/access/`. Modules are organised in three tiers — lower tiers have no knowledge of anything above them.

```
Tier 1 — Primitives
  config.js        Resolves the config path and owns config.json I/O (cached singleton).
                   Exports getBaseDir(), getVaultPath(), getWorkspacePath() and
                   getDatabasePath(), which all derive from the active config.
  sqliteAdapter.js The async driver contract, as a factory. Both stores below are instances.
                   prepare() is synchronous, its .get/.all/.run are async; a transaction
                   holds an exclusive lock on ITS OWN store, and each instance has its own
                   queue and transaction context.
  database.js      The vault database — one adapter instance over getDatabasePath().
                   Re-pointed when the active vault changes.
  accounts.js      The accounts store at {baseDir}/accounts.db — accounts, roles and token
                   hashes. Outside every vault; never re-opened on a switch. See § Accounts.
  vault.js         Vault identity (vault.json). Imports config only.

Tier 2 — Single-resource access
  query.js      All parameterised SQL statements. The only layer allowed to call db.prepare().
  files.js      All filesystem operations. The only layer allowed to read/write .flashback sidecars.

Tier 3 — Orchestration
  srs.js          Coordinates review submissions: updates Flashcards and inserts ReviewLogs in one transaction.
  documents.js    Main orchestrator. Coordinates files + query + srs to keep both layers in sync.
  subscriptions.js Coordinates issue import/merge on top of documents.
  media.js        Coordinates media management for the flashcards.
  decks.js        Coordinates deck CRUD and standalone (document-less) flashcards; dual-writes a
                   canonical JSON file per deck (workspace/_decks/<uuid>.json) and the Decks/
                   DeckEntries tables.
  highlights.js   Coordinates document-scoped highlights (sidecar highlights[] + Highlights table).

Tier 3 — Package import (built on the orchestration tier, loaded on demand by the import route)
  ankiImport.js      Parses a .apkg into decks + standalone-ish cards. Talks to files/query/decks
                      directly — never imports documents.js, since Anki cards have no source file.
  obsidianImport.js  Parses a vault .zip into a mirrored folder of real documents via documents.js,
                      plus files/query directly for media copying and tag/link extraction.
```

**Rules that keep this stable long-term:**

- `query.js` and `files.js` never import each other.
- `srs.js` and `documents.js` never import each other.
- `documents.js` may be imported by any Tier 3 orchestrator that needs to create/update real
  workspace files as part of a larger operation — currently `subscriptions.js` and
  `obsidianImport.js`. (Previously written as a `subscriptions.js`-only exception; no longer
  accurate now that `obsidianImport.js` exists.)
- Raw `db.prepare()` calls outside `query.js` are not allowed, except a single `PRAGMA table_info(Decks)` schema-introspection check in `decks.js` (not a data query).
- Filesystem access outside `files.js` is not allowed (except temp-dir work in orchestrators).

---

## Seal — Workspace Versioning

Seal is a git-backed versioning layer that sits alongside the access hierarchy in `src/api/seal/`. It is a self-contained subsystem with its own internal separation of concerns.

### Purpose

Every write operation through `Documents.js` produces an atomic git commit in the workspace git repository (`workspaceRoot`). This gives Flashback a full history of the canonical layer — user documents, `.flashback` sidecars, and media — without requiring git to be installed on the host machine (uses [isomorphic-git](https://isomorphic-git.org/)).

### Repository Layout

The Seal git repository is initialised at `workspaceRoot` (`{vaultPath}/workspace`) on startup by `sealTools.init()` (called from `main.js` after validation). The vault database and `config.json` live outside `workspaceRoot` and are never tracked.

```
{baseDir}/
├── config.json               ← not tracked
└── {vaultName}/              ← vault root, e.g. dreams/
    ├── {vaultName}.db        ← derived layer, not tracked
    └── workspace/            ← git repo root (sealTools.init here)
        ├── .git/
        ├── .flashback
        ├── MyFolder/
        │   ├── .flashback
        │   ├── note.md
        │   └── note.md.flashback
        └── ...
```

### Internal Structure

```
src/api/seal/
  seal.js
    SealEventEmitter   Primitive. No database knowledge. Stages files and commits
                       after each Documents.js write. One commit per operation.
    SealTools          Orchestrator. Imports query.js to coordinate git operations
                       with database state (rollback SRS handling, inspect reconciliation).
```

`SealTools` is the only component in the Seal subsystem allowed to import `query.js`.

### Commit Format

Each commit message follows the pattern `<action>: <sidecar-path>`:

| Action                             | Trigger                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `create: path/file.md.flashback` | `createFile`, `createFolder`, `importFile`                                          |
| `edit: path/file.md.flashback`   | `updateFile`, `updateMetadata`, `submitReview`, `addMediaToFlashcard`             |
| `move: old/path -> new/path`     | `rename`, `move`                                                                      |
| `delete: path/file.md.flashback` | `delete`                                                                                |
| `reconcile: <path \| N files>`    | `SealTools.commitDrift()` — the Vault Doctor sealing out-of-band changes it reconciled |

For folder operations, all contained file and sidecar paths are staged in the same commit so each commit represents one atomic user action.

### Rollback and SRS State

SRS progress (`level`, `ease_factor`, `last_recall`) lives in the database and is not embedded in git history. Rolling back the canonical layer therefore presents a conflict between content state and review progress. `SealTools.rollback(ref, keepSrsProgress)` handles this:

- **`keepSrsProgress: true` (default)** — snapshots all current SRS state (keyed by `global_hash`) before checkout. After checkout the snapshot is re-applied in a single transaction via `query.batchRestoreFlashcardSrsState()`. Cards that no longer exist in the rolled-back layer are silently dropped.
- **`keepSrsProgress: false`** — SRS reverts with the content. The sidecars carry a point-in-time snapshot of SRS state from when the commit was made, which becomes the new source of truth.

In both cases the derived layer must be reconciled to the rolled-back sidecars before the app is fully consistent. This is what the **Vault Doctor** (`access/orchestration/doctor.js`, `/api/doctor`) does: `syncIndex()` performs a direct workspace-walk ↔ DB comparison and applies the diff. Note that `sealTools.inspect()` is *blind right after a rollback* (HEAD == workdir, so `git.statusMatrix` reports no drift even though the index is diverged) — which is exactly why the Doctor walks the disk directly rather than relying on git status. Post-rollback there is no git drift, so the reconciling sync creates no new `reconcile:` commit.

### Out-of-band Change Detection

`sealTools.inspect()` diffs HEAD against the current workdir using `git.statusMatrix` and returns:

```js
{ added: string[], modified: string[], deleted: string[] }
```

Only `.flashback` sidecar paths are returned. This drift feeds the Seal view's "Loose pages" panel and is one input to the Vault Doctor, which reconciles each category against the derived layer:

- **added** — index the new sidecar into the database (`documents.indexDocument` / `indexFolder`)
- **modified** — re-sync the sidecar's flashcards and metadata (`documents.reindexDocument`)
- **deleted** — remove the corresponding document or folder from the database (`documents.removeFromIndex`)

The Doctor's `checkIndex()` does **not** rely on `inspect()` alone (it is blind after a rollback, see above) — it walks the workspace and compares against the DB directly, using git drift only as supplementary context. `SealTools.commitDrift()` is the inverse of `inspect()`: it stages *all* out-of-band changes (including deletions, and non-sidecar files) into one `reconcile:` commit so a later rollback treats them as real history.

---

## Diary — Study Record

The **diary** is an opt-in, per-day record of study activity implemented in `src/api/access/orchestration/diary.js` (`/api/diary`). It is deliberately **not** part of the knowledge graph: it is metadata *about* studying, not study material.

### Purpose

When enabled, a machine-written **summary** is derived from `ReviewLogs` every time a study session completes, and the user may optionally add a free-form markdown **entry** for any day. The diary powers a review-history view and can feed AI assistants (privacy-gated, below).

### Repository Layout

The diary lives at `{vaultPath}/diary/` — a **sibling of `workspace/`, not inside it**:

```
{baseDir}/
└── {vaultName}/                     ← vault root
    ├── {vaultName}.db               ← derived layer
    ├── workspace/                   ← Seal git repo (documents)
    └── diary/                       ← the diary — its OWN git repo
        ├── .git/
        ├── summaries/summary-YYYY-MM-DD.json   ← the OWNER's, machine-derived, read-only in the UI
        ├── entries/entry-YYYY-MM-DD.md         ← the OWNER's optional prose
        └── accounts/<accountId>/               ← everyone else, same shape underneath
            ├── summaries/summary-YYYY-MM-DD.json
            └── entries/entry-YYYY-MM-DD.md
```

The owner keeps the unprefixed layout — the same unmarked-owner shape as `OWNER_SCOPE` in the database — so no existing file moves, no git rename appears in anyone's history, and a vault written before accounts existed reads back unchanged.

**One repo covers all of it, so one git history holds several people's prose.** That is a real property to state to the people involved, not an oversight: a shared vault's diary is not a private local diary, and it is what M5's "Logs" rebrand and its privacy warning exist to say out loud.

Two consequences follow from the sibling location:

- **Invisible for free.** The file walker (`files.walkWorkspace`), global search, and the knowledge graph only descend inside `workspaceRoot`, so diary files never appear in search results, graph output, the file explorer, or flashcard anchoring — with no exclusion code. No flashcards can be created on diary files.
- **Its own git repo.** Seal's repo root *is* `workspace/`, so it does not track the diary. `diary.js` therefore carries a separate `isomorphic-git` repo, initialised **lazily on first write** (never at startup — the feature is opt-in on the client, and an opted-out vault stays clean). Commits follow the same `<action>: <path>` convention with actions `summary` and `entry`. Writes are atomic (temp + rename).

Summary and entry are **independent files joined only by their date key** — neither is a sidecar of the other. A summary can exist with no entry (the common case); an entry can exist with no summary (a rest-day journal). There is **one cumulative summary per date**: multiple sessions in a day regenerate the same file.

### Summary schema (v2)

Summaries are **derived data**: fully regenerable from `ReviewLogs`. `generateSummary` is idempotent and cumulative — regenerating a past date reproduces the same file (modulo `generatedAt`), which makes corruption recoverable and powers the "rebuild diary" command (`POST /api/diary/rebuild`). The day boundary is the user's **local calendar day** (`date(timestamp, 'localtime')` in SQLite), matching the Stats view. It is local rather than UTC because the API runs on the user's own machine, so its clock is the one they were studying by — bucketing in UTC filed an evening session west of Greenwich under the next day's summary. Every day-keyed reader (diary aggregates, the Stats heatmap/streak, the client's "today") must use the same boundary or they disagree with each other.

```json
{
  "schemaVersion": 2,
  "date": "2026-07-10",
  "generatedAt": "2026-07-10T22:31:04.000Z",
  "totals": { "reviews": 57, "uniqueCards": 43, "newCards": 8, "failed": 6 },
  "retention": {
    "passRate": 0.895,
    "reviewPassRate": 0.94, "reviewCount": 45,
    "learningPassRate": 0.72, "learningCount": 12
  },
  "byDeck": [ { "deck": "Japanese_Hiragana_Basic", "reviews": 40, "failed": 3 } ],
  "byDocument": [ { "path": "Notas/programacion.md", "reviews": 5 } ],
  "struggledCards": [ { "globalHash": "…", "front": "ぬ", "failCount": 2 } ],
  "streak": { "current": 12, "longest": 34 }
}
```

Field notes:

- `newCards` = cards whose earliest-ever real review falls on this date; `failed` counts `outcome = 0` rows; `passRate = (reviews - failed) / reviews`.
- **v2** splits the day's reviews on the same acquisition boundary the Stats view uses (`LEARNING_REVIEWS` in `access/orchestration/srs.js`): a review is *learning* while it is among its card's first N reviews **ever** (not just today's), *review* afterwards. `reviewPassRate` is the honest retention figure for the day; `learningPassRate` shows how new material landed. Either is `null` when that phase had no reviews. `passRate` keeps its v1 meaning (all reviews) so v1 summaries stay readable; re-run "rebuild diary" to backfill the v2 fields.
- `byDeck` is a per-deck view (a card in two decks counts once per deck); `byDocument` covers document-anchored cards only. `struggledCards` is capped at 10, most-failed first (`front` is `(custom card)` for custom-HTML cards).
- `streak` is computed **as of the summary's date** (not wall-clock "now"), so regeneration stays idempotent.
- Synthetic rebuild logs (`outcome IS NULL`, seeded by the Vault Doctor to preserve SM-2 ease) are excluded from every aggregate.
- `timeSpentMs` and a session count were intentionally **omitted** in v1 — neither is cheaply derivable from `ReviewLogs` (no per-review duration, no session id), and v1 adds no new tracking.

### AI-assistant privacy gate

The diary holds personal reflections, so access by the MCP server (a *separate* process — see the MCP server notes) is gated by the **`mcpDiaryAccess`** setting in `config.json` (default off), chosen in Config → AI Assistant. It has three levels: **`none`** closes the whole diary namespace, **`summaries`** exposes the machine-derived study summaries and the day list but keeps the personal written entries (the `/entry` routes) private, and **`full`** opens everything. (The flag used to be a boolean; `true` is still read as `full` and `false` as `none` for back-compat.) Enforcement is server-side: the MCP client tags every request with `X-Flashback-Client: mcp`, and `routes/diary.js` returns `403` for MCP-tagged requests according to the level. The setting is read **fresh from disk** (`config.getMcpDiaryAccess`, fail-closed — any unrecognized value → `none`) so changing it takes effect without an API restart. The React renderer sends no such header, so the in-app Diary view is never gated. The read-only tools are `diary_list`, `diary_get_summary`, and `diary_get_entry` (the last requires `full`).

---

## Accounts — who may reach this install

`{baseDir}/accounts.db`. A third store, alongside the canonical files and the derived vault database, and the only one that belongs to neither layer: it describes **people and access**, not knowledge.

### Why it is outside the vault

A vault folder is meant to be copied, moved, backed up onto a stick and handed to someone else. An access list that travelled with it would grant that person's install whatever the original readers had, on a vault they now own outright — the credentials of one deployment leaking into another. Roles are a fact about *this* deployment; the documents know nothing about them.

Three consequences follow, and each is load-bearing:

- **The Vault Doctor must never touch it.** The Doctor's whole premise is that the derived layer can be thrown away and re-derived from the canonical files. There is no canonical form of an account, so a rebuild that swept this in would delete every token in the deployment with no way back but the terminal.
- **It cannot be reconstructed.** Everything else in a Flashback install can: sidecars rebuild the index, Seal rebuilds the sidecars. Nothing rebuilds this. **It is a backup obligation**, and the only one in the app.
- **It is not re-opened on a vault switch.** Accounts belong to the install; a person does not stop being the owner because they opened a different vault.

### Shape

```
Accounts(id, name, email, role, created_at, active)
AccountTokens(id, account_id → Accounts.id, token_hash, label, created_at, last_used_at, revoked_at)
AccountProgress(vault_id, account_id → Accounts.id, card_hash,
                level, sm2_reps, last_recall, ease_factor,
                fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses,
                updated_at)          -- PK (vault_id, account_id, card_hash)
AccountsSchemaVersion(version, applied_at)
```

Created by `access/primitives/accounts.js` itself on first open, and never seen by `MigrationRunner` — that runner belongs to the vault database, and one version counter must not mean two things.

`AccountProgress` is the durable home of every **non-owner's** study schedule, and it is in this file for the same reason the access list is: it must not travel with a copied vault. See § Per-user progress. Keyed by `card_hash` (a card's `globalHash`) rather than a row id, because a Doctor rebuild reassigns every row id in the vault database and only the hash survives it; keyed by `vault_id` because this store is install-scoped and an install can hold several vaults.

`role` is one of `reader` < `collaborator` < `admin` < `author` (`src/shared/roles.js`), a strict ladder where each role can do everything below it. Exactly one Author exists; several Admins may.

Deactivating an **account** and revoking a **token** are deliberately separate: revoking one token leaves that person's other devices working, deactivating the account stops all of them at once.

### Tokens

Only `sha256(token)` is stored. The plaintext is returned exactly once, when the token is issued, and after that nobody — including the Author — can recover it; they rotate instead. Lookup is therefore by hash of the caller's input, which is why no constant-time comparison exists anywhere in the auth path.

`last_used_at` is written at most once per token per minute (throttled in process memory), because writing it per request would mean one write per card in a review session.

The **pure token** is the Author's, and it is what proves ownership of a deployment. Issuing a new one revokes every previous Author token in the same transaction — a rotation that revoked the old and failed to write the new would lock the owner out of their own vault. `npm run pure-token` does the same thing against the file directly, for a deployment whose API is stopped or refusing everyone; physical access to `accounts.db` is the authorization, which is the same bargain every database makes.

### On a desktop install

Nothing above is visible. `Api.start()` provisions one Author from the local identity in `config.json` (§ Local user identity) and adopts the existing `apiToken` as its token, so the renderer and the MCP server present what they always presented. Every request is that Author, and the Author may do everything — which is exactly how Flashback behaved before accounts existed.

Adoption also **re-enables** that token if a rotation had revoked it. `config.apiToken` is a plaintext secret in a file beside the vault database: anyone who can read it can already read every document directly, so refusing to honour it would buy nothing and would brick the desktop app with no in-app way back. A served deployment has no `apiToken` in its config, so the step does nothing there.

---

## Per-user progress

A card's schedule is a property of a **person**, not of the card. Before migration 010 it lived on the `Flashcards` row (`level`, `sm2_reps`, `last_recall`, the six `fsrs_*`), which is exactly right for one user and unusable the moment two people study one vault — they would grade each other's cards.

### The owner sentinel

Everything derived from a review is keyed by an **account scope**: an account id, or the literal `'owner'` (`src/api/requestContext.js`, `OWNER_SCOPE`).

`'owner'` is the vault's Author, and deliberately **not** their account id. Account ids live in `accounts.db`, which is install-scoped and does not travel with a copied vault. Stamping the Author's uuid into the vault database would orphan every row of owner progress the moment someone copied the folder to another install — the vault would arrive with a full history belonging to nobody present. The sentinel survives the copy and means "whoever owns these files here", which is the sense the sidecar has always carried.

It has a second, smaller payoff: migration 010 backfills to a literal, so it needs no account lookup and nothing about the accounts store has to exist when the vault database is migrated.

### Two canonical homes

| Whose | Canonical home | Travels with a copied vault | Versioned by Seal |
|---|---|---|---|
| The owner's | the `.flashback` sidecar | yes | yes |
| Everyone else's | `accounts.db` → `AccountProgress` | no | no |

Both project into the vault database's `CardProgress`, which is derived and rebuildable like everything else there.

A reader's progress cannot go in the sidecar, and the reason is not convenience: it would seal one person's study record into a git history that travels with the folder to whoever receives a copy. So **a non-owner's review writes no file and produces no Seal commit** — `documents.submitReview` and `undoReview` return early for a non-owner scope. Reading is not editing.

### What is durable and what is not

Only the schedule **snapshot** is mirrored to `AccountProgress`. Review logs are not, so losing the vault database still costs everyone their history, their card-health verdicts and their optimizer input — precisely what a Doctor rebuild has always cost the owner. The contract is unchanged, not weakened.

`ease_factor` is on `AccountProgress` although `CardProgress` has no such column: SM-2's ease is read back out of the latest review log, and there are no review logs in the accounts store. The Doctor re-seeds it as a synthetic log row during a rebuild, exactly as it already does for the owner.

The mirror is written **inside** the vault transaction and **after** the vault write. If it throws, the vault write rolls back with it, so the derived layer can never be ahead of the durable one. If the commit fails after the mirror succeeded, the durable copy is ahead and a rebuild re-projects it. Losing a graded review is the failure worth preventing; replaying one is not.

### Rebuild

`doctor.rebuildIndex()` restores the owner's progress from the sidecars, then re-projects every other account's from `AccountProgress` for this `vault_id`. It is **read-only toward the accounts store** — it may read a snapshot to re-project it and must never write or delete one. A snapshot whose card is gone is skipped and kept, not pruned: the card may be returning on the next sync, and a rebuild is not the moment to decide somebody's study history is garbage.

Neither cross-store reference (`CardProgress.account_id`, `AccountProgress.vault_id`) carries a foreign key, and neither can: they point across database files. Nothing cascades. Deleting an account leaves orphaned `CardProgress` rows in every vault; deactivating one deliberately keeps their progress, so a reactivated reader resumes rather than restarts.

### Resolving the scope

Resolved **once**, at each orchestrator's entry point (`srs.js`, `cardHealth.js`, `diary.js`, `sequencer.js`, `decks.js`), and passed down explicitly. `query.js` never reads it ambiently, and it **refuses a missing scope** rather than defaulting — defaulting to the owner would hand the owner's schedule to whoever forgot the argument, silently, which is the exact bug the split exists to prevent.

A few call sites name `OWNER_SCOPE` outright, and each is a place where the data genuinely belongs to the files rather than to the caller: reconciling against a sidecar (`_syncDocumentFlashcards`, the Doctor's drift check), writing a canonical file (`_decks/*.json` snapshots, an Anki import's carried-over schedule, `Documents.presence`), and Seal's rollback snapshot — which rewinds the workspace and must not rewind a reader's studying along with it.

---

# Derived data model

Derived data for faster optimized querying.
The Flashback schema is organized around the **Flashcard** as the atomic unit of knowledge.Supporting entities capture content, references, pedagogical context, relationships, and user review history.

- **Flashcards**

  - Core unit of memory representation.
  - Links to `FlashcardContent` (text, media), optional `FlashcardReference` (position in document), and `PedagogicalCategories`.
  - Connected to the knowledge graph via a `node_id` (in `Nodes`).
  - Trackable attributes like `last_recall`, `name`, and `presence`.
- **FlashcardContent**

  - Stores the actual front/back text, media (images, sounds), and optional rendered/custom HTML.
- **FlashcardReference**

  - Anchors a flashcard to a document position, page, or bounding box.
  - Allows spatial or positional memory association.
- **Highlights**

  - A document-scoped colored span (or PDF region) that exists independently of any flashcard; a flashcard optionally anchors to one via its `reference`'s `{type: 'highlight', id}`.
  - Synced from the owning document's sidecar `highlights[]` array on every save, not written through the flashcard-creation path.
- **Documents** and **Folders**

  - Hierarchical organization of knowledge sources.
  - Each has a `node_id` for integration into the graph.
  - Both can carry a `presence` metric for measuring familiarity.
- **PedagogicalCategories**

  - Defines priority for reviewing flashcards (e.g., definitions before concepts).
- **Tags**

  - Labels to organize and cluster concepts.
  - Tags inherit through `Connections` using `InheritedTags`.
- **Connections** and **ConnectionTypes**

  - Define graph edges between `Nodes`. Connection types in active use: `connection`, `disconnection` (an explicit override that suppresses a same-pair `connection` edge), `inheritance`, `tag`, `reference`, `deck`, `link`.
  - `is_directed` marks whether the relationship has directionality (`inheritance` and `reference` are directed; the rest are not).
- **Nodes** and **NodeTypes**

  - Universal graph nodes that can represent flashcards, documents, folders, tags, or decks.
  - Provide flexible abstraction for connections. A `DELETE` trigger on each typed table removes the corresponding `Nodes` row automatically.
- **Media**

  - Repository of static assets (images, audio, etc.), retrievable by `hash` or `name`.
- **ReviewLogs**

  - Tracks spaced repetition history per flashcard.
  - Includes `timestamp`, `outcome`, `ease_factor`, and `level` for performance analysis.
  - `algorithm` records which scheduler graded each review. The active algorithm is a browser preference, so this row is the only way the API — and through it the MCP server, which has no browser — can know which scheduler a vault is actually on (`srs.detectAlgorithm()`). NULL on rows written before migration 006.
- **Decks** and **DeckEntries**

  - A deck is a user-curated, named collection of flashcard references (linked by hash, not copied). Canonical storage is a JSON file per deck under `workspace/_decks/`; the DB tables are a queryable mirror kept in sync on every write.
  - One deck is flagged `is_system` and holds every standalone (document-less) flashcard, so those cards still participate in deck-scoped study sessions.
  - A deck may carry `tags` (stored in its `_decks/<uuid>.json` and as direct tags on the deck's graph node). Deck tags **flow down to member cards** as inherited tags, stored on the deck→card `Connections` row (type `deck`) — the same `InheritedTags` mechanism folders use, so a card carries the union of its document-chain tags and every deck it belongs to. Adding a card to a tagged deck tags it immediately; removing it (or deleting/retagging the deck) revokes those tags via `InheritedTags`' cascade on `connection_id`. Decks have no parent, so their own tags are direct-only (never inherited).
- **DocumentLinks**

  - A hash-keyed queue of `flashback://` wiki-style links found in Markdown documents, resolved lazily so a link to a not-yet-imported document is still recorded.
  - Rendered as `link`-type graph edges between Document nodes.
- **Subscriptions**

  - Tracks magazine/course subscriptions. One row per `magazine_id`.
  - Stores the current `issue_id`, `version`, `target_path` (where in the workspace the content lives), and `last_sync` timestamp.
  - Updated on each `importIssue()` call by `subscriptions.js`. No UI currently triggers this — reachable only via direct API call.

---

## Session Sequencing — Presentation Order

Two separate decisions, deliberately kept apart:

- **Selection** — *which* cards are due today. Owned entirely by the scheduler (`srs.js`, `query.getDueFlashcards`) and decided from due dates alone.
- **Sequencing** — the *order* those cards are presented in. Owned by `sequencer.js` / `sequencing.js`.

**Topology never moves a card across days.** Nothing in sequencing may pull a card forward or defer one to engineer a comparison; that would corrupt the retention estimates, which are already hard to read through new-card noise. The two are composed at the route layer (`routes/srs.js` `GET /due`), never folded into each other — the same arrangement `cardHealth.js` uses to stay out of the scheduler.

### Why interleave

Before this existed, the trainer presented cards in creation order: both sort stages were stable sorts on `category_priority` alone, so every tie resolved to rowid order and cards authored together from one document arrived together, every session, in the same sequence. That is blocked practice. It inflates within-session accuracy while producing knowledge bound to the thematic cue — the shared context does the retrieving, and a shuffled recall attempt the next day doesn't supply it.

So graph proximity is used as a **spacing signal, not a grouping one**. Confusable cards still co-occur inside a session, because that is where discrimination is learned, but separated by unrelated material.

### Approximate distance

A real BFS over `Nodes`/`Connections` is more machinery than the signal justifies; what matters is which band a pair falls in. `query.getSessionFacets()` reads each card's `docId`, `folderId`, folder ancestry, tags (direct + inherited), decks and linked documents in a fixed number of statements, and `distance()` derives:

| d | relationship                                                               |
| - | -------------------------------------------------------------------------- |
| 1 | same document, shared tag, or same immediate folder —**confusable** |
| 2 | shared deck, or their documents are directly linked                        |
| 3 | documents share an ancestor folder within two levels                       |
| 4 | nothing in common                                                          |

### Constraints

- **Hard** — two cards at d ≤ 1 must be separated by at least `MIN_LAG` (4) items.
- **Soft** — prefer the medium-to-high band (`TARGET_DISTANCE` 3), *not* the maximum. Always jumping as far as possible makes every transition the same kind of jump and the relational structure itself never gets retrieved.
- **Soft** — a **weak** card (new, or level ≤ 2) may take a same-cluster run of up to `WEAK_RUN_MAX` (3) so the learner can extract the pattern before discriminating under load. Per-card, outgrown automatically as strength rises; never a mode the user selects.
- Pedagogical tiers are an outer partition — sequencing happens *within* a tier, so a definition is never reordered behind the exercise built on it.

### Degradation ladder

Reported as `relaxation` on the `/due` response. **Failure degrades toward randomness, never toward clusters** — a shuffle is already better than blocking.

| rung               | trigger                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `none`           | the full lag held                                                                                                               |
| `no-folder-edge` | > 40% of pairs read as confusable; the same-folder edge is dropped first (in a flat vault it alone makes everything confusable) |
| `short-lag`      | the tier's geometry can't sustain`MIN_LAG`; the lag drops to what actually fits                                               |
| `shuffle`        | not even adjacent placement fits; plain seeded shuffle                                                                          |

The `short-lag` rung is computed, not guessed: spacing *k* cluster-mates *g* apart inside *n* slots requires `(k-1)(g+1)+1 ≤ n`. Honouring an infeasible lag anyway is what strands the remainder in a block at the end of the session — the exact blocking the feature exists to prevent.

Ordering is seeded (`mulberry32`), so a session is reproducible from its seed and `tests/sequencing.test.js` can pin exact sequences.

---

## Data Dictionary

### Table: Flashcards

| Column       | Type         | Description                                                                                                                                                                                                                  |
| ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id           | integer (PK) | Unique identifier for each flashcard.                                                                                                                                                                                        |
| global_hash  | varchar(500) | Global hash for deduplication and synchronization.                                                                                                                                                                           |
| node_id      | integer (FK) | Links flashcard into the knowledge graph.                                                                                                                                                                                    |
| document_id  | integer (FK) | References the source document, if any.**(ON DELETE CASCADE)**                                                                                                                                                         |
| category_id  | integer (FK) | Pedagogical category (e.g., definition, concept).                                                                                                                                                                            |
| content_id   | integer (FK) | Points to the flashcard’s content (front/back).                                                                                                                                                                             |
| reference_id | integer (FK) | Anchors flashcard to a document position.                                                                                                                                                                                    |
| name         | varchar(500) | Optional descriptive name of the flashcard.                                                                                                                                                                                  |
| origin       | varchar(500) | Provenance marker:`'ai'` = created by an AI assistant (via the MCP server); `NULL` = handmade (UI, imports). Set once at creation, never edited afterwards. Mirrored in the sidecar card's `origin` field (canonical). |
| presence     | float        | Familiarity/strength metric (derived from reviews). The document-level counterpart is `Documents.presence`; both are the **owner's**, because they are mirrored into the canonical layer.                                     |
| fileIndex    | integer      | Position of the flashcard within its source file.                                                                                                                                                                            |
| card_type    | text         | Card variant:`basic`, `reversible`, `cloze`, `type_answer`, or `custom`. Defaults to `’basic’`. Added via live migration on first startup if the column is absent.                                             |

**No schedule columns.** `level`, `sm2_reps`, `last_recall` and the six `fsrs_*` columns lived here until migration 010 moved them into `CardProgress` and dropped them from this table. Dropping rather than deprecating was deliberate: a stale column that still reads turns "this query forgot to scope itself" from a hard error into one person quietly studying another person's schedule.

`document_id` is nullable — a **standalone card** (created from the Flashcards browser, not anchored to any document) has `document_id = NULL` and lives only in the DB plus an entry in the reserved system deck's JSON file (see `Decks` below).

---

### Table: CardProgress

One person's schedule for one card. See § Per-user progress for why it exists and where each person's canonical copy lives.

| Column          | Type         | Description                                                                                                                                                              |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id              | integer (PK) | Unique identifier.                                                                                                                                                       |
| flashcard_id    | integer (FK) | The card. **(ON DELETE CASCADE)**                                                                                                                                        |
| account_id      | text         | An account id from `accounts.db`, or the literal `'owner'`. **No foreign key** — it points into a different database file. Defaults to `'owner'`.                          |
| level           | integer      | Number of consecutive positive recalls (Leitner box).                                                                                                                    |
| sm2_reps        | integer      | Repetition count under SM-2, separate from `level`. Defaults to 0.                                                                                                       |
| last_recall     | timestamp    | Last time this person recalled this card.                                                                                                                                |
| fsrs_stability  | float        | FSRS-6 latent stability, in days. NULL until this person has rated the card under FSRS.                                                                                  |
| fsrs_difficulty | float        | FSRS-6 latent difficulty.                                                                                                                                                |
| fsrs_due        | timestamp    | Explicit next-due datetime under FSRS (the other schedulers derive theirs from `last_recall` + interval).                                                                 |
| fsrs_state      | integer      | FSRS card state; 0 = new. Defaults to 0.                                                                                                                                 |
| fsrs_reps       | integer      | FSRS review count. Defaults to 0.                                                                                                                                        |
| fsrs_lapses     | integer      | FSRS lapse count. Defaults to 0.                                                                                                                                         |

`UNIQUE(flashcard_id, account_id)`.

**A missing row means "never reviewed by this person"** — which is exactly what a zero `level` and a NULL `last_recall` already meant. Every reader COALESCEs, so a row appears on a card's first review rather than at creation, and nothing has to be seeded when a card is imported.

---

### Table: Highlights

| Column      | Type         | Description                                                                                                  |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| id          | integer (PK) | Unique identifier.                                                                                           |
| document_id | integer (FK) | Owning document.**(ON DELETE CASCADE)**                                                                |
| global_hash | varchar(500) | UUID, unique — the id referenced by a flashcard's`location: { type: 'highlight', id }`.                   |
| type        | varchar(50)  | Anchoring strategy:`text_offset` (default), `pdf_bbox`, `clip_range`, `video_timestamp` (free-text). |
| start       | float        | Start offset/position (meaning depends on`type`).                                                          |
| end         | float        | End offset/position.                                                                                         |
| page        | integer      | PDF page number, if applicable.                                                                              |
| bbox        | json         | Bounding box for PDF anchoring (stored as text).                                                             |
| color       | varchar(20)  | Swatch key (e.g.`amber`/`green`/`blue`/`pink`), defaults to `amber`.                               |
| note        | text         | Optional free-text note attached to the highlight.                                                           |
| created_at  | timestamp    | Creation time.                                                                                               |

A highlight is a first-class entity independent of any flashcard — it exists as long as its owning document does, and multiple flashcards may anchor to the same one. It is synced from the document's sidecar `highlights[]` array on every save (`highlights.syncFromSidecar`), not written by a flashcard insert. See the "Reference examples" section above for how a flashcard's `location` points at a highlight by its `global_hash`.

---

### Table: DocumentLinks

| Column      | Type         | Description                                             |
| ----------- | ------------ | ------------------------------------------------------- |
| id          | integer (PK) | Unique identifier.                                      |
| source_hash | varchar(500) | `global_hash` of the document containing the link.    |
| target_hash | varchar(500) | `global_hash` of the linked document.                 |
| anchor_text | varchar(500) | The link's visible text at the time it was last synced. |

A hash-based queue, not a graph table — it has no foreign keys, so a link to a not-yet-imported document can be recorded immediately and resolved lazily once the target exists. `(source_hash, target_hash)` is unique. Populated by `documents.syncDocumentLinks()`, which scans saved Markdown for `[text](flashback://hash)` links; the Graph view renders these as toggleable `link`-type edges between Document nodes.

---

### Table: Decks

| Column      | Type         | Description                                                                                                               |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| id          | integer (PK) | Unique identifier.                                                                                                        |
| node_id     | integer (FK) | Integration into the graph.                                                                                               |
| global_hash | varchar(500) | UUID, unique — also the filename of the deck's canonical JSON (`_decks/<global_hash>.json`).                           |
| name        | varchar(500) | Deck name.                                                                                                                |
| description | text         | Optional description.                                                                                                     |
| is_system   | integer      | `1` for the single reserved deck that holds standalone (document-less) cards; `0` otherwise. Protected from deletion. |
| created_at  | timestamp    | Creation time.                                                                                                            |
| updated_at  | timestamp    | Last-modified time.                                                                                                       |

This table is a queryable mirror of the canonical `_decks/<uuid>.json` files under `workspace/` — every write goes to the JSON file first, then this row, so the two never drift (a DB write failure rolls back the JSON write). `_decks/` is filtered out of the file explorer's document tree.

---

### Table: DeckEntries

| Column        | Type         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id            | integer (PK) | Unique identifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| deck_id       | integer (FK) | Owning deck.**(ON DELETE CASCADE)**                                                                                                                                                                                                                                                                                                                                                                                                                               |
| card_hash     | varchar(500) | `global_hash` of the referenced flashcard — decks link to cards, they don't copy them.                                                                                                                                                                                                                                                                                                                                                                               |
| document_path | varchar(500) | Relative path of the card's source document, if any (denormalized for display without a join).                                                                                                                                                                                                                                                                                                                                                                          |
| position      | integer      | Insertion order within the deck; defaults to 0. No manual reordering UI exists yet.                                                                                                                                                                                                                                                                                                                                                                                     |
| inline_card   | text         | JSON snapshot of a standalone (document-less) card's content, written by`decks.createStandaloneCard`/`updateStandaloneCard` alongside the system-deck JSON entry. Cards are still looked up by `card_hash` in normal operation; this snapshot exists so the Vault Doctor's `rebuildIndex()` can restore standalone cards from the canonical files after the derived layer is wiped (their content lives nowhere else on disk). Null for document-sourced cards. |

---

### Table: FlashcardContent

| Column      | Type         | Description                                                                                                                                                                                                           |
| ----------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id          | integer (PK) | Unique identifier for content.                                                                                                                                                                                        |
| custom_html | text         | User-provided HTML formatting.                                                                                                                                                                                        |
| render_html | text         | Processed HTML for display.                                                                                                                                                                                           |
| frontText   | varchar(500) | Text shown on the front of the flashcard.                                                                                                                                                                             |
| backText    | varchar(500) | Text shown on the back of the flashcard. On a`type_answer` card this is post-review notes, never compared.                                                                                                          |
| answerText  | varchar(500) | `type_answer` only: the expected answer, the sole value compared to what the reviewer types. NULL on other types, and on a `type_answer` card that predates the split (its answer is then still in `backText`). |
| front_img   | varchar(500) | Path/URL of image for front side.                                                                                                                                                                                     |
| back_img    | varchar(500) | Path/URL of image for back side.                                                                                                                                                                                      |
| front_sound | varchar(500) | Path/URL of audio for front side.                                                                                                                                                                                     |
| back_sound  | varchar(500) | Path/URL of audio for back side.                                                                                                                                                                                      |

---

### Table: FlashcardReference

| Column | Type         | Description                                               |
| ------ | ------------ | --------------------------------------------------------- |
| id     | integer (PK) | Unique identifier for reference.                          |
| type   | varchar(500) | Type of reference (text, pdf, video, etc.).               |
| start  | float        | Start offset (time, character, etc.).                     |
| end    | float        | End offset.                                               |
| page   | integer      | Page number if applicable.                                |
| bbox   | json         | Bounding box for precise anchoring (x, y, width, height). |

---

### Table: Documents

| Column        | Type         | Description                                         |
| ------------- | ------------ | --------------------------------------------------- |
| id            | integer (PK) | Unique document identifier.                         |
| folder_id     | integer (FK) | Parent folder.**(ON DELETE CASCADE)**         |
| node_id       | integer (FK) | Integration into graph.                             |
| global_hash   | varchar(500) | Hash for deduplication/sync.                        |
| relative_path | varchar(500) | Relative path to file.                              |
| absolute_path | varchar(500) | Absolute path to file.                              |
| name          | varchar(500) | Display name of the document.                       |
| origin        | varchar(500) | Source identifier (e.g., subscription magazine_id). |
| encoding      | varchar(20)  | Detected character encoding of the file.            |
| presence      | float        | Familiarity/usage score.                            |

---

### Table: Folders

| Column        | Type         | Description                                                  |
| ------------- | ------------ | ------------------------------------------------------------ |
| id            | integer (PK) | Unique folder identifier.                                    |
| global_hash   | varchar(500) | Hash for deduplication.                                      |
| node_id       | integer (FK) | Integration into graph.                                      |
| parent_id     | integer (FK) | Parent folder.**(ON DELETE CASCADE, nullable = root)** |
| relative_path | varchar(500) | Relative path to folder.                                     |
| absolute_path | varchar(500) | Absolute path to folder.                                     |
| name          | varchar(500) | Folder name.                                                 |
| origin        | varchar(500) | Source identifier (e.g., subscription magazine_id).          |
| presence      | float        | Familiarity/usage score.                                     |

---

### Table: PedagogicalCategories

| Column      | Type         | Description                                            |
| ----------- | ------------ | ------------------------------------------------------ |
| id          | integer (PK) | Unique identifier.                                     |
| name        | varchar(500) | Category name (definition, concept, relation, etc.).   |
| priority    | integer      | Priority for review ordering (lower = reviewed first). |
| description | text         | Human-readable description of the category.            |

---

### Table: Tags

| Column   | Type         | Description                                          |
| -------- | ------------ | ---------------------------------------------------- |
| id       | integer (PK) | Unique identifier.                                   |
| name     | varchar(500) | Tag label.                                           |
| node_id  | integer (FK) | Integration into graph.**(ON DELETE CASCADE)** |
| origin   | varchar(500) | Source identifier (e.g., subscription magazine_id).  |
| presence | float        | Familiarity/usage score.                             |

---

### Table: Connections

| Column     | Type         | Description                               |
| ---------- | ------------ | ----------------------------------------- |
| id         | integer (PK) | Unique identifier for connection.         |
| origin_id  | integer (FK) | Source node.**(ON DELETE CASCADE)** |
| destiny_id | integer (FK) | Target node.**(ON DELETE CASCADE)** |
| type_id    | integer (FK) | Type of connection.                       |

---

### Table: Nodes

| Column  | Type         | Description                   |
| ------- | ------------ | ----------------------------- |
| id      | integer (PK) | Unique identifier.            |
| type_id | integer (FK) | Type of node (see NodeTypes). |

---

### Table: Media

| Column        | Type         | Description                       |
| ------------- | ------------ | --------------------------------- |
| id            | integer (PK) | Unique identifier.                |
| hash          | varchar(500) | Hash for deduplication/retrieval. |
| name          | varchar(500) | Media name.                       |
| relative_path | varchar(500) | Relative path.                    |
| absolute_path | varchar(500) | Absolute path.                    |

---

### Table: NodeTypes

| Column | Type         | Description                                                 |
| ------ | ------------ | ----------------------------------------------------------- |
| id     | integer (PK) | Unique identifier.                                          |
| name   | varchar(500) | Name of node type (flashcard, document, folder, tag, etc.). |

---

### Table: ConnectionTypes

| Column      | Type         | Description                                             |
| ----------- | ------------ | ------------------------------------------------------- |
| id          | integer (PK) | Unique identifier.                                      |
| name        | varchar(500) | Type of connection (default: disconnection, inherited). |
| is_directed | integer      | Whether the edge is directional (1 = true, 0 = false).  |

---

### Table: InheritedTags

| Column        | Type         | Description                                                   |
| ------------- | ------------ | ------------------------------------------------------------- |
| id            | integer (PK) | Unique identifier.                                            |
| connection_id | integer (FK) | Connection carrying the tag.**(ON DELETE CASCADE)**     |
| tag_id        | integer (FK) | Tag applied through inheritance.**(ON DELETE CASCADE)** |

---

### Table: ReviewLogs

| Column              | Type         | Description                                                                                                                                         |
| ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                  | integer (PK) | Unique identifier.                                                                                                                                  |
| flashcard_id        | integer (FK) | Reviewed flashcard.**(ON DELETE CASCADE)**                                                                                                    |
| account_id          | varchar(64)  | **Whose review this was**: an account id, or `'owner'`. NOT NULL, defaults to `'owner'`. Indexed. See § Per-user progress.                     |
| timestamp           | timestamp    | When the review occurred.                                                                                                                           |
| outcome             | integer      | Result of recall (e.g., success, failure).                                                                                                          |
| ease_factor         | float        | Spaced repetition ease factor.                                                                                                                      |
| level               | integer      | Current level/stage in SRS algorithm.                                                                                                               |
| algorithm           | varchar(20)  | Scheduler that graded this review (`leitner`/`sm2`/`fsrs`). NULL pre-migration 006.                                                           |
| session_id          | varchar(64)  | Groups the reviews of one trainer session. Indexed. NULL pre-migration 009 and for non-trainer callers.                                             |
| session_position    | integer      | 0-based index of this review within its session, counting what was*actually shown* — a re-queued card occupies two positions.                    |
| prev_distance       | integer      | Approximate graph distance (1–4) to the card presented immediately before. NULL for a session's first review.                                      |
| nearest_sibling_lag | integer      | Items since the nearest*confusable* sibling (same document, shared tag, same parent folder) appeared in this session. NULL when none preceded it. |

**Session-ordering columns record how a card was PRESENTED, not how it was graded.** They exist because interleaving (see § Session Sequencing) deliberately trades within-session accuracy for delayed retention: pass rates are *expected* to drop when it is enabled, and without this context that dip is indistinguishable from a regression in the scheduler, the classifier, or the content. All four are written by `routes/srs.js` from `sequencer.measureOrdering()` and are NULL for every caller with no session — the MCP server, scripts, the Flashcards view. **A reader must treat NULL as "not recorded", never as distance 0**: a review with no logged ordering is not a review that happened next to its sibling. No backfill exists or is possible — presentation order was never recorded, and inventing one would poison the measurement these columns exist to make.

**Only the grade is stored, never the typed answer.** That is the binding constraint on Card Health below: error-content analysis (edit distance between successive wrong answers, matching a wrong answer against another card's back) is not possible from this table. Persisting typed answers for `type_answer` cards would unlock much stronger signals and is a candidate for a future additive migration.

---

### Table: CardHealth

The **analysis watermark**, one row per evaluated card **per account**. A card-health flag is a live judgement, not a permanent scar: once the user *addresses* a card, analysis restarts from that moment, so review history from before the fix is never held against the card that replaced it.

Per-account because the verdict is about how the card is *built* but the evidence is one person's interval trajectory — two people can sit at different watermarks on the same card, and one person's dismissal is not everyone's.

| Column              | Type         | Description                                                                                                |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| id                  | integer (PK) | Unique identifier.                                                                                         |
| flashcard_id        | integer (FK) | The card.**(ON DELETE CASCADE)**                                                                     |
| account_id          | varchar(64)  | Whose analysis this is: an account id, or`'owner'`. UNIQUE together with `flashcard_id`.             |
| epoch_at            | timestamp    | Analysis window start. Reviews at or before this are not evidence. NULL = the card's whole history counts. |
| epoch_reason        | varchar(20)  | What moved the watermark:`edit`, `recovered`, `dismissed`.                                           |
| content_fingerprint | varchar(64)  | Hash of front + back + answer + custom HTML + card type at last evaluation.                                |
| updated_at          | timestamp    | Last write.                                                                                                |

`content_fingerprint` is how an edit is detected **without an edit hook**. `cardHealth.buildContext()` compares the card's current fingerprint against the stored one and resets the epoch on a mismatch, so an edit arriving through *any* path — the PUT route, the MCP server, a Seal rollback, a Vault Doctor reindex — invalidates the card's flags without those paths knowing the classifier exists. That check is per-account and lazy, which is what makes an edit cost nothing for people who are not looking at the card.

**The edit hook is the one cross-account operation.** `cardHealth.onCardEdited()` takes no scope: it clears *every* account's flags on the card and moves every account's watermark at once. The lazy fingerprint check would get each account there eventually, one failing review at a time, but a reader who never touched the card should not go on being warned about text they can see has been rewritten.

---

### Table: CardFlags

One row per **currently-raised** flag, per person. `UNIQUE(flashcard_id, account_id, kind)`: for a given reader a card either currently reads as a mouthful or it doesn't, so re-raising refreshes the evidence in place rather than stacking duplicates.

| Column             | Type         | Description                                                            |
| ------------------ | ------------ | ---------------------------------------------------------------------- |
| id                 | integer (PK) | Unique identifier.                                                     |
| flashcard_id       | integer (FK) | The flagged card.**(ON DELETE CASCADE)**                         |
| account_id         | varchar(64)  | Whose evidence raised it: an account id, or`'owner'`.            |
| kind               | varchar(40)  | `mouthful`, `probe`, `overdue_drift`, `session_fatigue`.       |
| confidence         | varchar(20)  | `moderate` or `high`.                                              |
| score              | float        | How strongly the detector fired (0–1).                                |
| evidence_json      | text         | The numbers behind the verdict — see below.                           |
| level_at_detection | integer      | The card's SRS level when the flag was raised.                         |
| detected_at        | timestamp    | When it was last raised or refreshed.                                  |
| review_log_id      | integer      | The failing review that raised it. Not an FK — the row can be undone. |
| dismissed_at       | timestamp    | Set when the user rules on it. Suppressed, not deleted.                |

`evidence_json` is what makes a flag arguable rather than an oracle: the peak-interval series across relearn cycles, the FSRS difficulty slope, the answer's token count against the vault median, overdue ratios, lapse count and window age, plus `memoryModel` (`fsrs` or `approximated`). The UI renders it; the user can disagree with it.

### Card Health — lifecycle

Classification runs **only when a card has just failed**. There is no reason to guess at why a card is failing when it isn't, and criticising a card that is working is the failure mode the design exists to avoid.

| Trigger                                                  | Effect                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Failing review (`outcome = 0`, or FSRS `rating = 1`) | Classify over the epoch window; upsert flags. A dismissed row is refreshed but stays suppressed.                             |
| Passing review reaching**level ≥ 3**              | Recovery: delete live flags, stamp`epoch_reason = 'recovered'`.                                                            |
| Passing review below level 3                             | Nothing. A mouthful passes constantly at a one-day interval — treating any pass as success would make the flag unreachable. |
| Content edit                                             | Delete**all** flags including dismissed ones; stamp `epoch_reason = 'edit'`. A rewritten card is judged fresh.       |
| Dismiss                                                  | Set`dismissed_at` on that one kind (a card can carry both guards); move the watermark.                                     |
| Undo review                                              | Re-classify against the shortened ledger, so a flag never cites a review that no longer exists.                              |

Both tables are **derived**: absent from `.flashback` sidecars, recomputable from `ReviewLogs` plus card content, and never sealed — a flag written canonically would mean a git commit on every failed review. They are cleared by `query.wipeDerivedContent()`, so a Vault Doctor `rebuildIndex` (which destroys `ReviewLogs` history) takes card health with it and cards re-earn their flags from new review behaviour.

Detector semantics, the mouthful/probe discriminator and the guard-precedence rule are documented in `src/api/access/ACCESS.md` § `cardHealth.js`.

---

### Table: Subscriptions

| Column      | Type         | Description                                              |
| ----------- | ------------ | -------------------------------------------------------- |
| id          | integer (PK) | Unique identifier.                                       |
| magazine_id | varchar(500) | Unique identifier for the subscription source.           |
| issue_id    | varchar(500) | Identifier of the last imported issue.                   |
| version     | varchar(100) | Version string of the last imported issue.               |
| target_path | varchar(500) | Relative workspace path where the content was installed. |
| last_sync   | timestamp    | Timestamp of the last successful import.                 |

---

### Table: CanonicalVersion

Which **canonical updates** this vault has finished — the counterpart of `SchemaVersion`, which tracks changes to this derived database. Written by `config/UpdateRunner.js` only after a pass completes with nothing skipped; a pass that skipped a file leaves no row and is retried on the next launch.

| Column      | Type         | Description                                          |
| ----------- | ------------ | ---------------------------------------------------- |
| version     | integer (PK) | Update version, matching`config/updates/NNN_*.js`. |
| applied_at  | timestamp    | When the pass completed.                             |
| description | text         | The update's one-line summary.                       |

This table is an **optimisation, not the source of truth**: it is what lets startup skip walking every sidecar when nothing is pending. The authority is the `formatVersion` stamped on each canonical file (see § Canonical file versioning), so losing this table costs one redundant walk, not correctness.
