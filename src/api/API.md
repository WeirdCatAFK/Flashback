# Flashback API

The Flashback API provides the core logic for the memorization workspace, including file system orchestration and data persistence.

## Validation & Initialization

Before the API starts, it undergoes a mandatory validation process to ensure the runtime environment and database are in a healthy state.

**Critical Step**: For details on how the environment and database are validated or repaired at startup, please consult the [Validation Guide](./config/validators/VALIDATION.md).

## Core Responsibilities
- **Orchestration**: Synchronizes canonical `.flashback` files with the derived SQLite database.
- **SRS Engine**: Manages the Spaced Repetition logic and mastery propagation.
- **File Management**: Handles secure file operations within the workspace root.

---

## Routes

Base URL: `http://localhost:3000` (default port, configurable)

All request bodies are JSON unless marked **multipart**. All responses are JSON unless noted otherwise. Paths in request bodies or query strings may use forward slashes on any platform; the server normalizes them internally.

---

## Documents `/api/documents`

### `GET /api/documents/list`

Lists the contents of a workspace folder. Sidecar files (`.flashback`) are excluded from the result.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `path` | query | string | No | Relative folder path. Defaults to workspace root. |

**Response** `200` — array of `{ name, type, metadata }` objects.

---

### `GET /api/documents/read`

Returns the raw content and sidecar metadata for a single document.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `path` | query | string | Yes | Relative path to the document. |

**Response** `200` — `{ content, encoding, metadata }`.

**Errors** `400` path required.

---

### `GET /api/documents/search`

Full-text search across document content, flashcard text, and tags.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `q` | query | string | Yes | Search query. |

**Response** `200` — array of matching result objects.

**Errors** `400` q required.

---

### `GET /api/documents/graph`

Returns the full knowledge graph.

**Response** `200` — `{ nodes, edges }`.

---

### `GET /api/documents/export`

Streams a `.zip` archive of the given folder as a file download.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `path` | query | string | Yes | Relative path to the folder to export. |

**Response** `200` — binary zip stream (`Content-Disposition: attachment`).

**Errors** `400` path required.

---

### `POST /api/documents/folder`

Creates a new folder in the workspace.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Folder name. |
| `parentPath` | string | No | Parent folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` name required.

---

### `POST /api/documents/file`

Creates a new empty document in the workspace.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | File name including extension. |
| `parentPath` | string | No | Parent folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` name required.

---

### `PUT /api/documents/file`

Updates the content and/or metadata of an existing document. Also syncs tags, flashcards, and inherited tags in the database.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Relative path to the document. |
| `content` | string | No | New file content. |
| `metadata` | object | No | Sidecar metadata (tags, flashcards, etc.). |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path required.

---

### `PUT /api/documents/metadata`

Updates only the sidecar metadata of a file or folder without touching its content.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Relative path to the item. |
| `metadata` | object | Yes | New metadata object. |
| `isFolder` | boolean | No | `true` if the path is a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path required.

---

### `DELETE /api/documents`

Deletes a file or folder (including all contents) from both disk and database.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Relative path to the item. |
| `isFolder` | boolean | No | `true` if the path is a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path required.

---

### `POST /api/documents/move`

Moves a file or folder to a new location, updating all database references.

| Field | Type | Required | Description |
|---|---|---|---|
| `srcPath` | string | Yes | Current relative path. |
| `destPath` | string | Yes | New relative path. |
| `isFolder` | boolean | No | `true` if moving a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` srcPath and destPath required.

---

### `POST /api/documents/copy`

Copies a file or folder to a new location. All copied items receive new `globalHash` values; the original hashes are preserved in a `copiedFrom` field on the sidecar.

| Field | Type | Required | Description |
|---|---|---|---|
| `srcPath` | string | Yes | Source relative path. |
| `destPath` | string | Yes | Destination relative path. |
| `isFolder` | boolean | No | `true` if copying a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` srcPath and destPath required.

---

### `POST /api/documents/rename`

Renames a file or folder in place.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Relative path to the item. |
| `newName` | string | Yes | New name only (not a full path). |
| `isFolder` | boolean | No | `true` if the item is a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path and newName required.

---

### `POST /api/documents/import`

Imports a single plain-text document into the workspace. **Multipart form data.**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | Yes | The document file. |
| `name` | string | Yes | File name to use in the workspace. |
| `parentPath` | string | No | Destination folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` file and name required.

---

### `POST /api/documents/import/zip`

Imports a Flashback `.zip` package (produced by `GET /api/documents/export`) into the workspace. **Multipart form data.**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | Yes | The `.zip` file. |
| `targetPath` | string | No | Destination folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` file required.

---

## Media `/api/media`

### `GET /api/media`

Streams the raw bytes of a registered media asset identified by its SHA-256 hash. Used by the renderer to display images or play audio without needing to know the workspace path.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `hash` | query | string | Yes | SHA-256 hash of the media file. |

**Response** `200` — raw file bytes.

**Errors** `400` hash required · `404` media not found.

---

### `GET /api/media/list`

Lists all media files inside a folder's `media/` subdirectory, cross-referenced with the database to include hash information.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `path` | query | string | No | Relative folder path. Defaults to workspace root. |

**Response** `200` — array of `{ name, relativePath, absolutePath, hash }` objects. `hash` is `null` if the file is not yet registered in the database.

---

### `POST /api/media/vanilla`

Attaches an image or audio file to the front or back of a flashcard (vanilla flashcard format). **Multipart form data.**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | Yes | The media file. |
| `docPath` | string | Yes | Relative path to the parent document. |
| `flashcardHash` | string | Yes | `globalHash` of the target flashcard. |
| `name` | string | Yes | File name to store, including extension. |
| `type` | string | Yes | Slot to attach to: `frontImg`, `backImg`, `frontSound`, or `backSound`. |
| `position` | string | Yes | Index of the flashcard within the document (as a string). |

**Response** `201` — `{ ok: true }`.

**Errors** `400` all fields required.

---

### `POST /api/media/custom`

Attaches a custom media asset to an HTML-engine flashcard's `customData`. **Multipart form data.**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | Yes | The media file. |
| `docPath` | string | Yes | Relative path to the parent document. |
| `flashcardHash` | string | Yes | `globalHash` of the target flashcard. |
| `name` | string | Yes | Key name for the asset in `customData.media`. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` all fields required.

---

### `DELETE /api/media`

Removes a media file from disk, clears all sidecar references to it, and drops its database entry.

| Field | Type | Required | Description |
|---|---|---|---|
| `docPath` | string | Yes | Relative path to the parent document. |
| `mediaName` | string | Yes | File name of the media asset to remove. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` docPath and mediaName required.

---

### `POST /api/media/reconcile`

Scans the database for media entries whose files no longer exist on disk within a given folder and removes the stale records.

| Field | Type | Required | Description |
|---|---|---|---|
| `folderPath` | string | No | Relative folder path to scope the scan. Defaults to workspace root. |

**Response** `200` — `{ removed: number, orphans: string[] }`.

---

## SRS `/api/srs`

### `POST /api/srs/review`

Submits a spaced-repetition review result for a flashcard. Updates the card's level and ease factor in both the sidecar and the database, and appends a review log entry.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Relative path to the document containing the flashcard. |
| `flashcardHash` | string | Yes | `globalHash` of the flashcard. |
| `outcome` | number | Yes | Review outcome (`1` = correct, `0` = incorrect). |
| `easeFactor` | number | Yes | Updated ease factor computed by the client. |
| `newLevel` | number | Yes | New Leitner box level. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` all fields required.

---

### `GET /api/srs/stats`

Returns the Leitner box distribution and total flashcard count across the whole workspace.

**Response** `200` — `{ boxes: [{ level, count }], total: number }`.

---

## Subscriptions `/api/subscriptions`

### `POST /api/subscriptions/import`

Imports and merges a magazine issue zip into the workspace. New files are created; files matched by `globalHash` or path are updated in place; files present in the target folder but absent from the new issue are deleted. **Multipart form data.**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | Yes | The issue `.zip` file. Must contain a root `.flashback` sidecar with `subscription` metadata. |
| `magazineId` | string | Yes | Identifier for the magazine (used for deduplication and lookup). |
| `targetPath` | string | No | Destination folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` file and magazineId required.

---

### `GET /api/subscriptions/:magazineId`

Returns the stored subscription record for a magazine.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `magazineId` | path | string | Yes | Magazine identifier. |

**Response** `200` — `{ magazine_id, issue_id, version, target_path, ... }`.

**Errors** `404` subscription not found.

---

## Seal `/api/seal`

The Seal subsystem provides git-backed versioning of the canonical sidecar layer. Only `.flashback` sidecar files are tracked — the SQLite database is never committed.

### `GET /api/seal/log`

Returns recent Seal commits in reverse chronological order.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `limit` | query | number | No | Maximum number of commits to return. Default `20`. |

**Response** `200` — array of `{ oid, commit: { message, author, ... } }` objects.

---

### `GET /api/seal/inspect`

Compares the current workspace against `HEAD` and returns uncommitted sidecar changes. Call this after a rollback to identify which database records need to be reconciled.

**Response** `200` — diff object with added, modified, and deleted sidecars since the last commit.

---

### `POST /api/seal/rollback`

Rolls the canonical sidecar layer back to a given commit. By default, SRS progress (card levels and ease factors) is snapshotted before the checkout and re-applied afterward so review history is not lost. Call `GET /api/seal/inspect` after rollback to reconcile the derived database layer.

| Field | Type | Required | Description |
|---|---|---|---|
| `ref` | string | Yes | Commit OID to roll back to (from `GET /api/seal/log`). |
| `keepSrsProgress` | boolean | No | Preserve SRS state across the rollback. Default `true`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` ref required.
