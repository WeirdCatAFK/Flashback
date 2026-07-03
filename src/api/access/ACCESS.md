# Flashback Access Layer

The Access layer is the core of the Flashback system, responsible for maintaining synchronization between the canonical (filesystem) and derived (SQLite) data layers.

**CRITICAL**: All data modifications must go through these modules. Never write directly to `.flashback` sidecars or call `db.prepare()` outside of `query.js`. For the data model, see [DATAMODEL.md](../../../DATAMODEL.md).

---

## Tier Structure

Modules are organized in three strict tiers. A module may only import from tiers below it.

```
Tier 3 — Orchestration   documents · subscriptions · media · srs · decks · highlights · doctor
Tier 3 — Package import  ankiImport · obsidianImport   (built on top of the orchestration tier)
Tier 2 — Single-resource  query · files
Tier 1 — Primitives       config · database
```

Filenames on disk are lowercase (`query.js`, `files.js`, `config.js`, `database.js`, `documents.js`, `srs.js`, `subscriptions.js`, `media.js`, `decks.js`, `highlights.js`, `doctor.js`, `ankiImport.js`, `obsidianImport.js`) — module *class* names inside them are capitalized (e.g. `class Documents`, `class Decks`), which is the source of the mixed casing seen in imports elsewhere in the codebase.

**Import rules:**
- `query.js` and `files.js` never import each other.
- `srs.js` and `documents.js` never import each other.
- `documents.js` may be imported by other Tier 3 modules that need to create/update real workspace files as part of a larger operation — currently `subscriptions.js` (issue merge), `obsidianImport.js` (vault import creates one document per note), and `doctor.js` (re-indexes documents from disk). This was previously written as "only `Subscriptions.js`" before `obsidianImport.js` was added; treat it as "any orchestrator that needs real files may import `documents.js`," not a single-module exception.
- `doctor.js` is read-only toward the canonical layer: it re-derives the SQLite index from the on-disk files and sidecars but never writes document content or regenerates a `globalHash`. It imports `documents.js`, `decks.js`, `files.js`, `query.js`, and Seal.
- `ankiImport.js` does **not** import `documents.js` — Anki cards have no source document (they land in decks/standalone cards only), so it talks to `files.js`, `query.js`, and `decks.js` directly instead.
- Raw `db.prepare()` calls outside `query.js` are not allowed, with one narrow exception: `decks.js` runs a `PRAGMA table_info(Decks)` directly (schema introspection to detect whether the system-deck migration has run yet), not a data query.

---

## Tier 1 — Primitives

### `config.js`
Environment-aware config reader/writer. Detects Electron vs. Node.js runtime to locate `config.json`. Exposes:
- `get()` — returns the config object (cached after first read; creates default if missing).
- `getWorkspacePath()` — canonical resolver for `workspaceRoot`; respects `isCustomPath`/`customPath` from config, otherwise falls back to `USER_DATA_PATH/workspace`.
- `set(config)` — writes and caches a new config object.

### `database.js`
SQLite connection singleton via `better-sqlite3`. WAL mode and foreign keys are always enabled. The single exported `db` instance is shared across all modules.

---

## Tier 2 — Single-resource access

### `query.js`
The **only** layer allowed to call `db.prepare()` for data queries (see the `PRAGMA` exception above). Contains all parameterized SQL statements organized by domain (folders, documents, flashcards, highlights, decks, tags, nodes, media, SRS, etc.). Exported as a singleton instance.

### `files.js`
The **only** layer allowed to read/write `.flashback` sidecar files. Resolves all paths against `workspaceRoot` (set via `config.getWorkspacePath()`). Key responsibilities:
- `safePath(relPath)` — prevents directory traversal; all other methods call this internally.
- Create, read, update, delete files and folders on disk.
- Read/write sidecar JSON (`filename.ext.flashback` for files, `.flashback` inside folders).
- Charset detection via `chardet`/`iconv-lite` for imported documents.
- `globalHash` generation on file/folder creation (immutable after first assignment).
- `walkWorkspace()` — read-only, pre-order recursive walk returning `{folders, documents, mediaDirs, strayItems}`. Each folder/document entry carries `{relPath, meta, sidecarExists, sidecarCorrupt}`; `strayItems` are files with no sidecar (`kind: 'untracked-file'`) or sidecars with no owning file (`kind: 'orphan-sidecar'`). Skips `.git`, root-level `_decks`, and `media/` dirs (recorded in `mediaDirs`, not descended). Used by the Vault Doctor to compare disk against the index.

---

## Tier 3 — Orchestration

### `documents.js`
Main orchestrator. Coordinates `files`, `query`, `srs`, and `SealEventEmitter` atomically. Handles: `createFile`, `createFolder`, `importFile`, `importPackage`/`exportPackage`, `move`, `copy`, `rename`, `delete`, `readFile`, `updateFile`, `updateMetadata`, `listFolder`, `search`, `getGraph`, `addMediaToFlashcard`, `syncDocumentLinks` (parses `flashback://` links out of saved Markdown, mirrors them into the sidecar's `links[]` and materializes `Connections`/queues them in `DocumentLinks`). All writes use the `db.transaction(() => { ... })()` IIFE pattern and emit a Seal commit afterward.

**Link write ordering (important):** the sidecar's `links[]` array is derived from content but stored on disk, so it must be written *before* the operation's Seal commit — otherwise the post-commit link write leaves the sidecar permanently diverged from its sealed version (out-of-band drift that the Loose-pages panel and Vault Doctor report forever). `importFile` folds links into the sidecar before `sealEmitter.create`; `syncDocumentLinks` (the live-save path) only rewrites + reseals the sidecar when the links actually changed. `indexDocumentLinks(relPath)` is the **read-only** variant (Vault Doctor): it re-derives the DB `Connections` from content without writing the sidecar or emitting a Seal event.

The DB-registration core of `importFile` is factored out as `_registerDocumentDerived({name, fileRelPath, absPath, encoding, metadata})` (row + inheritance + tags + flashcards + highlights in one transaction; no filesystem writes, no Seal). It is shared with a set of **read-only indexing methods** used by the Vault Doctor — these re-derive the index from the on-disk files without writing document content, regenerating identities, or emitting Seal events:
- `indexDocument(relPath)` — index an on-disk document that has no DB row (delegates to `reindexDocument` if a row already exists); adopts the sidecar's `globalHash`, ensures ancestor folders exist, then resolves pending `flashback://` links.
- `reindexDocument(relPath)` — refresh an existing document's rows from its sidecar: adopt the sidecar `globalHash`, max-merge flashcard SRS state (a level lowered out-of-band never regresses the DB), and replace tags/highlights/links wholesale so out-of-band removals propagate.
- `indexFolder(relPath)` — ensure a folder row exists (`''` = the workspace root) and re-run tag inheritance; recursive top-down.
- `removeFromIndex(relPath, isFolder)` — drop the index rows for a path deleted on disk (no filesystem writes).

### `srs.js`
Handles spaced-repetition review submissions. `submitReview()` updates `Flashcards` and inserts into `ReviewLogs` in a single transaction; the client computes the new level/ease (see `DATAMODEL.md`), the server just persists it. `getLeitnerStats()`/`getDue()` return box distribution, mastery percentage, and scoped due-card queries. `migrateProgress()` remaps existing cards between the Leitner and SM-2 algorithms. Calls `query` and `database` only — never imports `documents.js`.

### `media.js`
Orchestrator for media asset lifecycle:
- `serve(hash)` — resolves a media file by SHA-256 hash for API streaming.
- `list(folderRelPath)` — enumerates a folder's `media/` dir cross-referenced with the DB.
- `addVanillaMedia()` — writes vanilla media (FS + sidecar + DB + Seal); a single call can also create the owning flashcard atomically so the client never has to sequence create → read hash → upload.
- `removeMedia()` — removes media (FS + sidecar + DB + Seal).
- `reconcile()` — drops DB entries whose files are missing on disk.

Custom HTML flashcard media linkage stays in `documents.addMediaToFlashcard()`, not here.

### `subscriptions.js`
Manages magazine/course issue import and merge. `importIssue()` unpacks a zip, compares it against the existing workspace folder (matching by `globalHash`, falling back to path), creates/updates/deletes files accordingly (anything under the target folder untouched by the new issue is pruned), and records the subscription in the DB. No route/UI currently calls this — reachable only via direct API call.

### `decks.js`
Orchestrator for user-curated card collections, and the **only** place standalone (document-less) flashcards are created/edited/deleted. Each deck is dual-written: a canonical JSON file at `workspace/_decks/<uuid>.json` (the Seal-tracked source of truth) and mirrored `Decks`/`DeckEntries` rows in the DB; the JSON write happens first and is rolled back if the DB write fails, keeping the two in sync. One deck is flagged `is_system` (auto-created by migration `003_system_deck.js`, protected from deletion) — it's the home for every standalone card. Key methods: `listDecks`, `createDeck`/`updateDeck`/`deleteDeck`, `addEntry`/`removeEntry` (also maintains a `deck`-type graph connection between the deck's node and the card's node), `searchCards` (cross-deck card search used by the "Add cards" panel), `createStandaloneCard`/`updateStandaloneCard`/`deleteStandaloneCard` (reject the call if the target card turns out to be document-linked, directing the caller to edit it from its document instead). Standalone-card create/update also snapshots the card's content into the deck JSON entry and `DeckEntries.inline_card`, so a rebuild can restore document-less cards from files alone.

Vault-Doctor helpers (used by `doctor.js`): `listDeckFiles()` (all `_decks/*.json` payloads), `diagnoseDecks()` (`{fileWithoutDb, dbWithoutFile, corruptFiles, entryMismatches, danglingEntries}`), `repairFromFiles()` (reconcile DB to the deck files — file wins on entry mismatch), and `rebuildFromFiles()` (re-import every deck file, restore standalone cards from their inline snapshots, and guarantee exactly one system deck).

### `highlights.js`
Orchestrator for document-scoped highlights — a highlight is a first-class entity (own DB row + sidecar entry) independent of any flashcard; a flashcard optionally anchors to one via a `{type: 'highlight', id: <sidecar id>}` reference (see `DATAMODEL.md`). Key methods: `getHighlights(relPath)`, `createHighlight`/`updateHighlight`/`deleteHighlight` (sidecar + `Highlights` table together), and `syncFromSidecar(documentId, highlightsData)` (reconciles the DB's `Highlights` rows for a document against its sidecar's `highlights[]` array on every save — inserts new ones, deletes ones no longer present).

### `doctor.js` (Vault Doctor)
Keeps the derived SQLite index consistent with the canonical `.flashback` layer. The index can drift from disk via out-of-band edits, Seal rollbacks, crashes, or DB corruption; the Doctor closes that loop with three operations (mounted at `/api/doctor`):
- `checkIndex()` — read-only whole-vault report. A **direct workspace-walk ↔ DB comparison** (via `files.walkWorkspace()`), *not* `sealTools.inspect()`, which diffs against git HEAD and is blind right after a rollback (HEAD == workdir while the index is maximally diverged); git drift is included as supplementary context only. Reports folders/documents `missingInDb`/`orphanedInDb`, `modified` (with reasons), `hashConflicts` (duplicate `globalHash`), media both directions, deck diagnosis, and counts. All cross-layer joins normalize `relative_path` to `/` once (the DB stores `path.sep`, git uses `/` — the #1 trap).
- `syncIndex({sealDrift=true})` — applies the report; **disk is the source of truth**. Indexes new items, reindexes modified ones (SRS max-merge, never regresses progress), removes rows for deleted items, reconciles media both directions, repairs decks. Skips (never auto-resolves) hash conflicts, corrupt sidecars, and untracked files, reporting them instead — a `globalHash` is never regenerated. By default seals remaining out-of-band drift into one `reconcile:` commit (`sealTools.commitDrift()`). Idempotent. Refuses to run if `PRAGMA integrity_check` fails, directing the caller to rebuild.
- `rebuildIndex()` — nuclear option. Wipes all derived content (`query.wipeDerivedContent()`, keeping only schema/seed tables) and re-indexes the entire canonical layer. Pre-creates any missing card categories (unknown categories are silently dropped at insert), restores standalone cards from deck inline snapshots, and re-seeds one synthetic `ReviewLogs` row per card to preserve its SM-2 ease. ReviewLogs *history* does not survive (levels and ease do, via the sidecars). Rerunnable but not atomic past the wipe: per-item failures collect into `warnings`.

---

## Tier 3 — Package Import (built on the orchestration tier)

These two modules parse a third-party archive format and populate decks/documents/media from it. They're dynamically `import()`-ed by `routes/documents.js` only when an import request actually needs them (avoids loading `better-sqlite3`'s Anki-DB-reading path and `adm-zip` parsing on every server start).

### `ankiImport.js`
Parses an Anki `.apkg` (opens `collection.anki21b`/`.anki21`/`.anki2` with a standalone `better-sqlite3` connection, independent of Flashback's own DB connection). Anki notes become Flashback cards 1:1 (not raw generated "cards", so multi-template notes collapse to one card); card type is inferred from the notetype (cloze/type-answer/image-occlusion/reversible/basic). Talks to `files.js` (media directory resolution), `query.js` (media dedup lookups, direct card/media inserts), and `decks.js` (deck lookup-or-create, `addEntry`/`createStandaloneCard`) — it never imports `documents.js`, because Anki cards have no source document.

### `obsidianImport.js`
Parses an Obsidian vault `.zip` into a mirrored folder tree of real documents. Talks to `documents.js` (`createFolder`/`importFile` — this is the actual document creation path) plus `files.js`/`query.js` directly for extras that don't fit the single-document `importFile` call: per-folder `media/` copying and DB registration, and frontmatter/wikilink/tag extraction ahead of each file's import.
