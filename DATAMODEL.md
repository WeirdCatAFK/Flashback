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

All user data is scoped to a **vault** — a named, self-contained directory identified by the `vaultName` field in `config.json`. Both data layers for a given vault live inside it.

```
{baseDir}/                        ← app data directory (or customPath if configured)
  config.json                     ← server configuration; lives outside vaults
  {vaultName}/                    ← vault root, e.g. dreams/
    workspace/                    ← canonical layer root (.flashback sidecars and documents)
    {vaultName}.db                ← derived layer (SQLite), e.g. dreams.db
```

`baseDir` resolves to `app.getPath(‘userData’)` in the Electron process and is passed to the API as the `USER_DATA_PATH` environment variable. Renaming a vault updates `vaultName` in `config.json` and renames the vault directory and database file on disk. The `workspace/` subdirectory is the root of the Seal git repository.

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

### Folder-level `.flashback` file

- Contains metadata and tags inherited by all files and flashcards within the folder.
- Example:

```json
{
  "globalHash": "unique-folder-hash", # A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Artificial Intelligence", "Course", "Fall 2024"],
}

```

### File-level `.flashback` file

- Contains metadata and flashcards for the specific file.
- Example:

```json
{
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

| `type`             | Producer                     | Position encoding                                   |
| ------------------ | ---------------------------- | --------------------------------------------------- |
| `text_offset`      | `.txt` (default)             | `start`/`end` char offsets, `text` snapshot fallback |
| *(inline)*         | Markdown                     | `<mark data-hl>` in the body; no offsets            |
| `pdf_bbox`         | `PdfRenderer`                | `page` + `bbox {x,y,width,height}` in PDF units (scale=1) |
| `clip_range`       | `ClipRenderer` (web clips)   | `start`/`end` char offsets into rendered `textContent`, `text` fallback |
| `video_timestamp`  | `YoutubeRenderer`            | `start`/`end` in **seconds** into the video          |

## Flashcard Types

Every flashcard has a `cardType` field (stored as `card_type TEXT NOT NULL DEFAULT 'basic'` in the DB). The type drives both the renderer and the form fields used to create or edit the card.

| `cardType`    | Description                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic`       | Standard two-sided flip. Front and back are independent text + media blocks.                                                                                                                                                                         |
| `reversible`  | Same data as basic, but direction (`forward` / `reverse`) is randomised per session so the card tests in both directions.                                                                                                                        |
| `cloze`       | Text with `{{blank}}` markers. Front shows underlined gaps; back reveals the filled words highlighted in amber. Both sides share the same `frontText` (stored in `vanillaData.frontText` and `vanillaData.backText`).                        |
| `type_answer` | Question in `frontText`; expected answer in `backText`. The front face shows an inline text input + Check button. The Trainer compares the typed value to `backText` (case-insensitive trim) and shows a correct/wrong verdict before grading. |
| `custom`      | Full HTML stored in `customData.html`. Rendered in a sandboxed `<iframe srcdoc>` (no network access). `vanillaData` fields are unused and kept empty.                                                                                          |

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
  "vanillaData": { "frontText": "What is the capital of France?",
                   "backText":  "Paris",
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
  config.js     Resolves the config path and owns config.json I/O (cached singleton).
                Exports getVaultPath(), getWorkspacePath(), and getDatabasePath(),
                which all derive from vaultName in the active config.
  database.js   Calls getDatabasePath() at module initialisation, creates the vault
                directory if absent, and exports the better-sqlite3 connection singleton.

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
- Raw `db.prepare()` calls outside `query.js` are not allowed, except a single `PRAGMA
  table_info(Decks)` schema-introspection check in `decks.js` (not a data query).
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

| Action                             | Trigger                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `create: path/file.md.flashback` | `createFile`, `createFolder`, `importFile`                              |
| `edit: path/file.md.flashback`   | `updateFile`, `updateMetadata`, `submitReview`, `addMediaToFlashcard` |
| `move: old/path -> new/path`     | `rename`, `move`                                                          |
| `delete: path/file.md.flashback` | `delete`                                                                    |
| `reconcile: <path \| N files>`     | `SealTools.commitDrift()` — the Vault Doctor sealing out-of-band changes it reconciled |

For folder operations, all contained file and sidecar paths are staged in the same commit so each commit represents one atomic user action.

### Rollback and SRS State

SRS progress (`level`, `ease_factor`, `last_recall`) lives in the database and is not embedded in git history. Rolling back the canonical layer therefore presents a conflict between content state and review progress. `SealTools.rollback(ref, keepSrsProgress)` handles this:

- **`keepSrsProgress: true` (default)** — snapshots all current SRS state (keyed by `global_hash`) before checkout. After checkout the snapshot is re-applied in a single transaction via `query.batchRestoreFlashcardSrsState()`. Cards that no longer exist in the rolled-back layer are silently dropped.
- **`keepSrsProgress: false`** — SRS reverts with the content. The sidecars carry a point-in-time snapshot of SRS state from when the commit was made, which becomes the new source of truth.

In both cases the derived layer must be reconciled to the rolled-back sidecars before the app is fully consistent. This is what the **Vault Doctor** (`access/doctor.js`, `/api/doctor`) does: `syncIndex()` performs a direct workspace-walk ↔ DB comparison and applies the diff. Note that `sealTools.inspect()` is *blind right after a rollback* (HEAD == workdir, so `git.statusMatrix` reports no drift even though the index is diverged) — which is exactly why the Doctor walks the disk directly rather than relying on git status. Post-rollback there is no git drift, so the reconciling sync creates no new `reconcile:` commit.

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

The **diary** is an opt-in, per-day record of study activity implemented in `src/api/access/diary.js` (`/api/diary`). It is deliberately **not** part of the knowledge graph: it is metadata *about* studying, not study material.

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
        ├── summaries/summary-YYYY-MM-DD.json   ← machine-derived, read-only in the UI
        └── entries/entry-YYYY-MM-DD.md         ← optional user prose
```

Two consequences follow from the sibling location:

- **Invisible for free.** The file walker (`files.walkWorkspace`), global search, and the knowledge graph only descend inside `workspaceRoot`, so diary files never appear in search results, graph output, the file explorer, or flashcard anchoring — with no exclusion code. No flashcards can be created on diary files.
- **Its own git repo.** Seal's repo root *is* `workspace/`, so it does not track the diary. `diary.js` therefore carries a separate `isomorphic-git` repo, initialised **lazily on first write** (never at startup — the feature is opt-in on the client, and an opted-out vault stays clean). Commits follow the same `<action>: <path>` convention with actions `summary` and `entry`. Writes are atomic (temp + rename).

Summary and entry are **independent files joined only by their date key** — neither is a sidecar of the other. A summary can exist with no entry (the common case); an entry can exist with no summary (a rest-day journal). There is **one cumulative summary per date**: multiple sessions in a day regenerate the same file.

### Summary schema (v1)

Summaries are **derived data**: fully regenerable from `ReviewLogs`. `generateSummary` is idempotent and cumulative — regenerating a past date reproduces the same file (modulo `generatedAt`), which makes corruption recoverable and powers the "rebuild diary" command (`POST /api/diary/rebuild`). The day boundary is **UTC** (`date(timestamp)` in SQLite), matching the Stats view.

```json
{
  "schemaVersion": 1,
  "date": "2026-07-10",
  "generatedAt": "2026-07-10T22:31:04.000Z",
  "totals": { "reviews": 57, "uniqueCards": 43, "newCards": 8, "failed": 6 },
  "retention": { "passRate": 0.895 },
  "byDeck": [ { "deck": "Japanese_Hiragana_Basic", "reviews": 40, "failed": 3 } ],
  "byDocument": [ { "path": "Notas/programacion.md", "reviews": 5 } ],
  "struggledCards": [ { "globalHash": "…", "front": "ぬ", "failCount": 2 } ],
  "streak": { "current": 12, "longest": 34 }
}
```

Field notes:

- `newCards` = cards whose earliest-ever real review falls on this date; `failed` counts `outcome = 0` rows; `passRate = (reviews - failed) / reviews`.
- `byDeck` is a per-deck view (a card in two decks counts once per deck); `byDocument` covers document-anchored cards only. `struggledCards` is capped at 10, most-failed first (`front` is `(custom card)` for custom-HTML cards).
- `streak` is computed **as of the summary's date** (not wall-clock "now"), so regeneration stays idempotent.
- Synthetic rebuild logs (`outcome IS NULL`, seeded by the Vault Doctor to preserve SM-2 ease) are excluded from every aggregate.
- `timeSpentMs` and a session count were intentionally **omitted** in v1 — neither is cheaply derivable from `ReviewLogs` (no per-review duration, no session id), and v1 adds no new tracking.

### AI-assistant privacy gate

The diary holds personal reflections, so access by the MCP server (a *separate* process — see the MCP server notes) is gated by the **`mcpDiaryAccess`** setting in `config.json` (default off), chosen in Config → AI Assistant. It has three levels: **`none`** closes the whole diary namespace, **`summaries`** exposes the machine-derived study summaries and the day list but keeps the personal written entries (the `/entry` routes) private, and **`full`** opens everything. (The flag used to be a boolean; `true` is still read as `full` and `false` as `none` for back-compat.) Enforcement is server-side: the MCP client tags every request with `X-Flashback-Client: mcp`, and `routes/diary.js` returns `403` for MCP-tagged requests according to the level. The setting is read **fresh from disk** (`config.getMcpDiaryAccess`, fail-closed — any unrecognized value → `none`) so changing it takes effect without an API restart. The React renderer sends no such header, so the in-app Diary view is never gated. The read-only tools are `diary_list`, `diary_get_summary`, and `diary_get_entry` (the last requires `full`).

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

## Data Dictionary

### Table: Flashcards

| Column       | Type         | Description                                                                                                                                                                      |
| ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id           | integer (PK) | Unique identifier for each flashcard.                                                                                                                                            |
| global_hash  | varchar(500) | Global hash for deduplication and synchronization.                                                                                                                               |
| node_id      | integer (FK) | Links flashcard into the knowledge graph.                                                                                                                                        |
| document_id  | integer (FK) | References the source document, if any.**(ON DELETE CASCADE)**                                                                                                             |
| category_id  | integer (FK) | Pedagogical category (e.g., definition, concept).                                                                                                                                |
| content_id   | integer (FK) | Points to the flashcard’s content (front/back).                                                                                                                                 |
| reference_id | integer (FK) | Anchors flashcard to a document position.                                                                                                                                        |
| last_recall  | timestamp    | Last time the flashcard was recalled.                                                                                                                                            |
| name         | varchar(500) | Optional descriptive name of the flashcard.                                                                                                                                      |
| origin       | varchar(500) | Source identifier (e.g., subscription magazine_id).                                                                                                                              |
| presence     | float        | Familiarity/strength metric (derived from reviews).                                                                                                                              |
| level        | integer      | Number of consecutive positive recalls.                                                                                                                                          |
| fileIndex    | integer      | Position of the flashcard within its source file.                                                                                                                                |
| card_type    | text         | Card variant:`basic`, `reversible`, `cloze`, `type_answer`, or `custom`. Defaults to `’basic’`. Added via live migration on first startup if the column is absent. |
| sm2_reps     | integer      | Repetition count under the SM-2 algorithm (separate from the Leitner `level`). Defaults to 0.                                                                                    |

`document_id` is nullable — a **standalone card** (created from the Flashcards browser, not anchored to any document) has `document_id = NULL` and lives only in the DB plus an entry in the reserved system deck's JSON file (see `Decks` below).

---

### Table: Highlights

| Column      | Type         | Description                                                                                     |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id          | integer (PK) | Unique identifier.                                                                                |
| document_id | integer (FK) | Owning document.**(ON DELETE CASCADE)**                                                    |
| global_hash | varchar(500) | UUID, unique — the id referenced by a flashcard's `location: { type: 'highlight', id }`.         |
| type        | varchar(50)  | Anchoring strategy:`text_offset` (default), `pdf_bbox`, `clip_range`, `video_timestamp` (free-text). |
| start       | float        | Start offset/position (meaning depends on `type`).                                                |
| end         | float        | End offset/position.                                                                              |
| page        | integer      | PDF page number, if applicable.                                                                   |
| bbox        | json         | Bounding box for PDF anchoring (stored as text).                                                  |
| color       | varchar(20)  | Swatch key (e.g.`amber`/`green`/`blue`/`pink`), defaults to `amber`.                            |
| note        | text         | Optional free-text note attached to the highlight.                                                |
| created_at  | timestamp    | Creation time.                                                                                     |

A highlight is a first-class entity independent of any flashcard — it exists as long as its owning document does, and multiple flashcards may anchor to the same one. It is synced from the document's sidecar `highlights[]` array on every save (`highlights.syncFromSidecar`), not written by a flashcard insert. See the "Reference examples" section above for how a flashcard's `location` points at a highlight by its `global_hash`.

---

### Table: DocumentLinks

| Column      | Type         | Description                                                                                     |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id          | integer (PK) | Unique identifier.                                                                                |
| source_hash | varchar(500) | `global_hash` of the document containing the link.                                                |
| target_hash | varchar(500) | `global_hash` of the linked document.                                                             |
| anchor_text | varchar(500) | The link's visible text at the time it was last synced.                                           |

A hash-based queue, not a graph table — it has no foreign keys, so a link to a not-yet-imported document can be recorded immediately and resolved lazily once the target exists. `(source_hash, target_hash)` is unique. Populated by `documents.syncDocumentLinks()`, which scans saved Markdown for `[text](flashback://hash)` links; the Graph view renders these as toggleable `link`-type edges between Document nodes.

---

### Table: Decks

| Column      | Type         | Description                                                                                     |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id          | integer (PK) | Unique identifier.                                                                                |
| node_id     | integer (FK) | Integration into the graph.                                                                       |
| global_hash | varchar(500) | UUID, unique — also the filename of the deck's canonical JSON (`_decks/<global_hash>.json`).      |
| name        | varchar(500) | Deck name.                                                                                         |
| description | text         | Optional description.                                                                             |
| is_system   | integer      | `1` for the single reserved deck that holds standalone (document-less) cards; `0` otherwise. Protected from deletion. |
| created_at  | timestamp    | Creation time.                                                                                     |
| updated_at  | timestamp    | Last-modified time.                                                                                |

This table is a queryable mirror of the canonical `_decks/<uuid>.json` files under `workspace/` — every write goes to the JSON file first, then this row, so the two never drift (a DB write failure rolls back the JSON write). `_decks/` is filtered out of the file explorer's document tree.

---

### Table: DeckEntries

| Column        | Type         | Description                                                                                     |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id            | integer (PK) | Unique identifier.                                                                                |
| deck_id       | integer (FK) | Owning deck.**(ON DELETE CASCADE)**                                                         |
| card_hash     | varchar(500) | `global_hash` of the referenced flashcard — decks link to cards, they don't copy them.            |
| document_path | varchar(500) | Relative path of the card's source document, if any (denormalized for display without a join).    |
| position      | integer      | Insertion order within the deck; defaults to 0. No manual reordering UI exists yet.                |
| inline_card   | text         | JSON snapshot of a standalone (document-less) card's content, written by `decks.createStandaloneCard`/`updateStandaloneCard` alongside the system-deck JSON entry. Cards are still looked up by `card_hash` in normal operation; this snapshot exists so the Vault Doctor's `rebuildIndex()` can restore standalone cards from the canonical files after the derived layer is wiped (their content lives nowhere else on disk). Null for document-sourced cards. |

---

### Table: FlashcardContent

| Column      | Type         | Description                               |
| ----------- | ------------ | ----------------------------------------- |
| id          | integer (PK) | Unique identifier for content.            |
| custom_html | text         | User-provided HTML formatting.            |
| render_html | text         | Processed HTML for display.               |
| frontText   | varchar(500) | Text shown on the front of the flashcard. |
| backText    | varchar(500) | Text shown on the back of the flashcard.  |
| front_img   | varchar(500) | Path/URL of image for front side.         |
| back_img    | varchar(500) | Path/URL of image for back side.          |
| front_sound | varchar(500) | Path/URL of audio for front side.         |
| back_sound  | varchar(500) | Path/URL of audio for back side.          |

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

| Column       | Type         | Description                                      |
| ------------ | ------------ | ------------------------------------------------ |
| id           | integer (PK) | Unique identifier.                               |
| flashcard_id | integer (FK) | Reviewed flashcard.**(ON DELETE CASCADE)** |
| timestamp    | timestamp    | When the review occurred.                        |
| outcome      | integer      | Result of recall (e.g., success, failure).       |
| ease_factor  | float        | Spaced repetition ease factor.                   |
| level        | integer      | Current level/stage in SRS algorithm.            |

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
