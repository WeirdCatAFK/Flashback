# Flashback Access Layer

The Access layer is the core of the Flashback system, responsible for maintaining synchronization between the canonical (filesystem) and derived (SQLite) data layers.

**CRITICAL**: All data modifications must go through these modules. Never write directly to `.flashback` sidecars or call `db.prepare()` outside of `Query.js`. For the data model, see [DATAMODEL.md](../../../DATAMODEL.md).

---

## Tier Structure

Modules are organized in three strict tiers. A module may only import from tiers below it.

```
Tier 3 — Orchestration   Documents · Subscriptions · Media · SRS
Tier 2 — Single-resource  Query · Files
Tier 1 — Primitives       Config · Database
```

**Import rules:**
- `Query.js` and `Files.js` never import each other.
- `SRS.js` and `Documents.js` never import each other.
- `Subscriptions.js` is the only module allowed to import `Documents.js`.
- Raw `db.prepare()` calls outside `Query.js` are not allowed.

---

## Tier 1 — Primitives

### `Config.js`
Environment-aware config reader/writer. Detects Electron vs. Node.js runtime to locate `config.json`. Exposes:
- `get()` — returns the config object (cached after first read; creates default if missing).
- `getWorkspacePath()` — canonical resolver for `workspaceRoot`; respects `isCustomPath`/`customPath` from config, otherwise falls back to `USER_DATA_PATH/workspace`.
- `set(config)` — writes and caches a new config object.

### `Database.js`
SQLite connection singleton via `better-sqlite3`. WAL mode and foreign keys are always enabled. The single exported `db` instance is shared across all modules.

---

## Tier 2 — Single-resource access

### `Query.js`
The **only** layer allowed to call `db.prepare()`. Contains all parameterized SQL statements organized by domain (folders, documents, flashcards, tags, nodes, media, SRS, etc.). Exported as a singleton instance.

### `Files.js`
The **only** layer allowed to read/write `.flashback` sidecar files. Resolves all paths against `workspaceRoot` (set via `Config.getWorkspacePath()`). Key responsibilities:
- `safePath(relPath)` — prevents directory traversal; all other methods call this internally.
- Create, read, update, delete files and folders on disk.
- Read/write sidecar JSON (`filename.ext.flashback` for files, `.flashback` inside folders).
- Charset detection via `chardet`/`iconv-lite` for imported documents.
- `globalHash` generation on file/folder creation (immutable after first assignment).

---

## Tier 3 — Orchestration

### `Documents.js`
Main orchestrator. Coordinates `Files`, `Query`, `SRS`, and `SealEventEmitter` atomically. Handles: `createFile`, `createFolder`, `importFile`, `importZip`, `exportZip`, `move`, `copy`, `rename`, `delete`, `readFile`, `updateFile`, `updateMetadata`, `listFolder`, `search`, `getGraph`, `addMediaToFlashcard`. All writes use the `db.transaction(() => { ... })()` IIFE pattern and emit a Seal commit afterward.

### `SRS.js`
Handles spaced-repetition review submissions. `submitReview()` updates `Flashcards` and inserts into `ReviewLogs` in a single transaction. `getLeitnerStats()` returns box distribution and mastery percentage. Calls `Query` and `Database` only — never imports `Documents`.

### `Media.js`
Orchestrator for media asset lifecycle:
- `serve(hash)` — resolves a media file by SHA-256 hash for API streaming.
- `list(folderRelPath)` — enumerates a folder's `media/` dir cross-referenced with the DB.
- `addVanillaMedia()` — writes vanilla media (FS + sidecar + DB + Seal).
- `removeMedia()` — removes media (FS + sidecar + DB + Seal).
- `reconcile()` — drops DB entries whose files are missing on disk.

Custom HTML flashcard media linkage stays in `Documents.addMediaToFlashcard()`, not here.

### `Subscriptions.js`
Manages magazine/course issue import and merge. The **only** module allowed to import `Documents.js`. `importIssue()` unpacks a zip, compares it against the existing workspace folder (matching by `globalHash` or path), creates/updates/deletes files accordingly, and records the subscription in the DB.
