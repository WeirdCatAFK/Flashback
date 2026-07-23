
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

| Param    | In    | Type   | Required | Description                                       |
| -------- | ----- | ------ | -------- | ------------------------------------------------- |
| `path` | query | string | No       | Relative folder path. Defaults to workspace root. |

**Response** `200` — array of `{ name, type, metadata }` objects.

---

### `GET /api/documents/read`

Returns the decoded content and sidecar metadata for a single document.

| Param    | In    | Type   | Required | Description                    |
| -------- | ----- | ------ | -------- | ------------------------------ |
| `path` | query | string | Yes      | Relative path to the document. |

**Response** `200` — `{ content, encoding, binary, size, metadata }`.

Binary documents (PDF, EPUB, images, audio, video — recognized by container extension *or* by sniffing the first 8 KB) return `content: null`, `encoding: "binary"`, `binary: true`, and their `metadata` as usual: decoding those bytes as text produces only mojibake. Fetch the bytes from [`GET /api/documents/raw`](#get-apidocumentsraw) — which is what the PDF/EPUB renderers do, using this endpoint purely for the sidecar — or their **text** from [`/api/reader`](#reader-apireader).

**Errors** `400` path required.

---

### `GET /api/documents/search`

Search across document names, flashcard text, and tags (document *bodies* are covered by `/search/content` below).

| Param | In    | Type   | Required | Description   |
| ----- | ----- | ------ | -------- | ------------- |
| `q` | query | string | Yes      | Search query. |

**Response** `200` — array of matching result objects.

**Errors** `400` q required.

---

### `GET /api/documents/search/content`

Case-insensitive substring search inside text document bodies (which live on disk, not in the DB).

| Param | In    | Type   | Required | Description   |
| ----- | ----- | ------ | -------- | ------------- |
| `q` | query | string | Yes | Text to find. |
| `limit` | query | number | No | Max documents to return. Default `20`, max `100`. |

**Response** `200` — array of `{ path, name, matches, snippets }` objects (up to 3 context snippets per document).

**Errors** `400` q required.

---

### `GET /api/documents/links`

The `flashback://` wiki-link neighborhood of one document.

| Param | In    | Type   | Required | Description   |
| ----- | ----- | ------ | -------- | ------------- |
| `path` | query | string | Yes | Relative path to the document. |

**Response** `200` — `{ outgoing, backlinks, pending }`; `outgoing`/`backlinks` are `{ name, path, global_hash }` document refs, `pending` are `{ targetHash, anchorText }` links whose target document doesn't exist yet.

**Errors** `400` path required · `404` document not found.

---

### `GET /api/documents/graph`

Returns the full knowledge graph.

**Response** `200` — `{ nodes, edges }`.

---

### `GET /api/documents/export`

Streams a `.zip` archive of the given folder as a file download.

| Param    | In    | Type   | Required | Description                            |
| -------- | ----- | ------ | -------- | -------------------------------------- |
| `path` | query | string | Yes      | Relative path to the folder to export. |

**Response** `200` — binary zip stream (`Content-Disposition: attachment`).

**Errors** `400` path required.

---

### `POST /api/documents/folder`

Creates a new folder in the workspace.

| Field          | Type   | Required | Description                                     |
| -------------- | ------ | -------- | ----------------------------------------------- |
| `name`       | string | Yes      | Folder name.                                    |
| `parentPath` | string | No       | Parent folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` name required.

---

### `POST /api/documents/file`

Creates a new empty document in the workspace.

| Field          | Type   | Required | Description                                     |
| -------------- | ------ | -------- | ----------------------------------------------- |
| `name`       | string | Yes      | File name including extension.                  |
| `parentPath` | string | No       | Parent folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` name required.

---

### `PUT /api/documents/file`

Updates the content and/or metadata of an existing document. Also syncs tags, flashcards, and inherited tags in the database.

| Field        | Type   | Required | Description                                |
| ------------ | ------ | -------- | ------------------------------------------ |
| `path`     | string | Yes      | Relative path to the document.             |
| `content`  | string | No       | New file content.                          |
| `metadata` | object | No       | Sidecar metadata (tags, flashcards, etc.). |

**Response** `200` — `{ ok: true }`.

A `content` write is accepted **only** for `.md` / `.markdown` / `.txt` / `.text` — the formats with an editable renderer in the app. Every other format is a viewer, so a body write to one can only come from outside the app, and bodies are not versioned by Seal (the overwrite is unrecoverable). Metadata-only writes are accepted on any document, which is how the PDF/EPUB renderers save their sidecars. Clip and YouTube bodies are written by their own endpoints, not here.

**Errors** `400` path required; `400` when `content` is present and the target is not an editable text format.

---

### `PUT /api/documents/metadata`

Updates only the sidecar metadata of a file or folder without touching its content.

| Field        | Type    | Required | Description                                          |
| ------------ | ------- | -------- | ---------------------------------------------------- |
| `path`     | string  | Yes      | Relative path to the item.                           |
| `metadata` | object  | Yes      | New metadata object.                                 |
| `isFolder` | boolean | No       | `true` if the path is a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path required.

---

### `DELETE /api/documents`

Deletes a file or folder (including all contents) from both disk and database.

| Field        | Type    | Required | Description                                          |
| ------------ | ------- | -------- | ---------------------------------------------------- |
| `path`     | string  | Yes      | Relative path to the item.                           |
| `isFolder` | boolean | No       | `true` if the path is a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path required.

---

### `POST /api/documents/move`

Moves a file or folder to a new location, updating all database references.

| Field        | Type    | Required | Description                                     |
| ------------ | ------- | -------- | ----------------------------------------------- |
| `srcPath`  | string  | Yes      | Current relative path.                          |
| `destPath` | string  | Yes      | New relative path.                              |
| `isFolder` | boolean | No       | `true` if moving a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` srcPath and destPath required.

---

### `POST /api/documents/copy`

Copies a file or folder to a new location. All copied items receive new `globalHash` values; the original hashes are preserved in a `copiedFrom` field on the sidecar.

| Field        | Type    | Required | Description                                      |
| ------------ | ------- | -------- | ------------------------------------------------ |
| `srcPath`  | string  | Yes      | Source relative path.                            |
| `destPath` | string  | Yes      | Destination relative path.                       |
| `isFolder` | boolean | No       | `true` if copying a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` srcPath and destPath required.

---

### `POST /api/documents/rename`

Renames a file or folder in place.

| Field        | Type    | Required | Description                                          |
| ------------ | ------- | -------- | ---------------------------------------------------- |
| `path`     | string  | Yes      | Relative path to the item.                           |
| `newName`  | string  | Yes      | New name only (not a full path).                     |
| `isFolder` | boolean | No       | `true` if the item is a folder. Default `false`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` path and newName required.

---

### `POST /api/documents/import`

Imports a single plain-text document into the workspace. **Multipart form data.**

| Field          | Type   | Required | Description                                          |
| -------------- | ------ | -------- | ---------------------------------------------------- |
| `file`       | file   | Yes      | The document file.                                   |
| `name`       | string | Yes      | File name to use in the workspace.                   |
| `parentPath` | string | No       | Destination folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` file and name required.

---

### `POST /api/documents/import/zip`

Imports a Flashback `.zip` package (produced by `GET /api/documents/export`) into the workspace. **Multipart form data.**

| Field          | Type   | Required | Description                                          |
| -------------- | ------ | -------- | ---------------------------------------------------- |
| `file`       | file   | Yes      | The`.zip` file.                                    |
| `targetPath` | string | No       | Destination folder path. Defaults to workspace root. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` file required.

---

## Reader `/api/reader`

Paginated, read-only **text extraction** for documents whose bodies are not decodable text (PDF, EPUB, saved web clips), plus character-window reads of ordinary text files. Built for the MCP server — which has no renderer and cannot receive bytes — but not restricted to it. Backed by [`access/mcpReader.js`](./access/ACCESS.md#mcpreaderjs); see there for the extraction rules and cache.

Addressing follows each format's **native unit**:

| Format | `unit` | Addressed by |
| --- | --- | --- |
| `.pdf` | `page` | `index` (1-based), `count` |
| `.epub` | `section` | `index` (1-based) **or** the spine href, `count` |
| `.md` `.markdown` `.txt` `.text` `.clip` `.youtube` | `chars` | `offset`, `limit` |

### `GET /api/reader/info`

What the document is and how much of it there is, without returning a body.

| Param  | In    | Type   | Required | Description                    |
| ------ | ----- | ------ | -------- | ------------------------------ |
| `path` | query | string | Yes      | Relative path to the document. |

**Response** `200` — `{ path, format, unit, total, extractable, note?, sections? }`. `total` counts pages, sections, or characters depending on `unit`. `sections` lists `{ index, label, href, chars }` for EPUBs. `extractable: false` with a `note` means the file parsed but holds no text layer (a scanned PDF needing OCR).

**Errors** `400` path required · `404` no such document · `415` format has no readable text.

### `GET /api/reader/read`

One window of text.

| Param        | In    | Type          | Required | Description                                                        |
| ------------ | ----- | ------------- | -------- | ------------------------------------------------------------------ |
| `path`       | query | string        | Yes      | Relative path to the document.                                     |
| `index`      | query | number/string | No       | Page or section (1-based), or an EPUB spine href. Default 1.       |
| `count`      | query | number        | No       | Pages/sections per call, capped at 10. Default 1.                  |
| `offset`     | query | number        | No       | `chars` unit: start position. Default 0.                           |
| `limit`      | query | number        | No       | `chars` unit: characters to return, capped server-side.            |
| `charOffset` | query | number        | No       | Resume inside a single oversized unit (see `nextCharOffset`).       |

**Response** `200` — `{ path, format, unit, index, total, label, text, hasMore, next, nextCharOffset, truncated }`. Follow `next` (and `nextCharOffset` when `truncated`) until `hasMore` is false. Every response is capped at 20 000 characters.

**Errors** `400` path required, index out of range, unknown href, or offset past the end · `404` no such document · `415` format has no readable text.

---

## Media `/api/media`

### `GET /api/media`

Streams the raw bytes of a registered media asset identified by its SHA-256 hash. Used by the renderer to display images or play audio without needing to know the workspace path.

| Param    | In    | Type   | Required | Description                     |
| -------- | ----- | ------ | -------- | ------------------------------- |
| `hash` | query | string | Yes      | SHA-256 hash of the media file. |

**Response** `200` — raw file bytes.

**Errors** `400` hash required · `404` media not found.

---

### `GET /api/media/list`

Lists all media files inside a folder's `media/` subdirectory, cross-referenced with the database to include hash information.

| Param    | In    | Type   | Required | Description                                       |
| -------- | ----- | ------ | -------- | ------------------------------------------------- |
| `path` | query | string | No       | Relative folder path. Defaults to workspace root. |

**Response** `200` — array of `{ name, relativePath, absolutePath, hash }` objects. `hash` is `null` if the file is not yet registered in the database.

---

### `GET /api/media/file`

Streams a flashcard media asset by its location relative to the owning document. Vanilla cards store media as `./media/<name>` paths (not hashes), so this is how the renderer resolves them.

| Param       | In    | Type   | Required | Description                                        |
| ----------- | ----- | ------ | -------- | -------------------------------------------------- |
| `docPath` | query | string | Yes      | Relative path to the document that owns the media. |
| `name`    | query | string | Yes      | Media file name (basename only).                   |

**Response** `200` — streams the file.

**Errors** `400` when `docPath`/`name` missing; `404` when the file is not found on disk.

---

### `POST /api/media/vanilla`

Two modes on one endpoint. **Multipart form data** in both cases.

**Create mode** — creates a vanilla flashcard and attaches its media in a single
call (no client-side "create card → read back hash → upload media" sequencing).
Triggered when a `card` field is present.

| Field           | Type          | Required | Description                                                                                                          |
| --------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `docPath`     | string        | Yes      | Relative path to the parent document.                                                                                |
| `card`        | string (JSON) | Yes      | The card object (front/back text, tags, category, location, …). Any`globalHash` is ignored — the API assigns it. |
| `front_img`   | file          | No       | Image for the front.                                                                                                 |
| `back_img`    | file          | No       | Image for the back.                                                                                                  |
| `front_sound` | file          | No       | Audio for the front.                                                                                                 |
| `back_sound`  | file          | No       | Audio for the back.                                                                                                  |

Stored media file names are generated server-side (collision-free in the shared
`media/` dir); the card's `vanillaData.media` is patched to reference them.

**Response** `201` — `{ ok: true, card }` where `card` is the persisted card including its assigned `globalHash` and media refs.

**Attach mode** — attaches one media file to an already-existing card. Triggered
when `card` is absent.

| Field             | Type   | Required | Description                              |
| ----------------- | ------ | -------- | ---------------------------------------- |
| `file`          | file   | Yes      | The media file.                          |
| `docPath`       | string | Yes      | Relative path to the parent document.    |
| `flashcardHash` | string | Yes      | `globalHash` of the target flashcard.  |
| `name`          | string | Yes      | File name to store, including extension. |
| `type`          | string | Yes      | `image` or `sound`.                  |
| `position`      | string | Yes      | `front` or `back`.                   |

**Response** `201` — `{ ok: true }`.

**Errors** `400` — `docPath` missing, `card` is not valid JSON, or (attach mode) a required field is missing.

---

### `POST /api/media/custom`

Attaches a custom media asset to an HTML-engine flashcard's `customData`. **Multipart form data.**

| Field             | Type   | Required | Description                                    |
| ----------------- | ------ | -------- | ---------------------------------------------- |
| `file`          | file   | Yes      | The media file.                                |
| `docPath`       | string | Yes      | Relative path to the parent document.          |
| `flashcardHash` | string | Yes      | `globalHash` of the target flashcard.        |
| `name`          | string | Yes      | Key name for the asset in`customData.media`. |

**Response** `201` — `{ ok: true }`.

**Errors** `400` all fields required.

---

### `DELETE /api/media`

Removes a media file from disk, clears all sidecar references to it, and drops its database entry.

| Field         | Type   | Required | Description                             |
| ------------- | ------ | -------- | --------------------------------------- |
| `docPath`   | string | Yes      | Relative path to the parent document.   |
| `mediaName` | string | Yes      | File name of the media asset to remove. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` docPath and mediaName required.

---

### `POST /api/media/reconcile`

Scans the database for media entries whose files no longer exist on disk within a given folder and removes the stale records.

| Field          | Type   | Required | Description                                                         |
| -------------- | ------ | -------- | ------------------------------------------------------------------- |
| `folderPath` | string | No       | Relative folder path to scope the scan. Defaults to workspace root. |

**Response** `200` — `{ removed: number, orphans: string[] }`.

---

## SRS `/api/srs`

### `POST /api/srs/review`

Submits a spaced-repetition review result for a flashcard. Updates the card's level and ease factor in both the sidecar and the database, and appends a review log entry.

| Field             | Type   | Required | Description                                             |
| ----------------- | ------ | -------- | ------------------------------------------------------- |
| `path`          | string | Yes      | Relative path to the document containing the flashcard. |
| `flashcardHash` | string | Yes      | `globalHash` of the flashcard.                        |
| `outcome`       | number | Yes      | Review outcome (`1` = correct, `0` = incorrect).    |
| `easeFactor`    | number | Yes      | Updated ease factor computed by the client.             |
| `newLevel`      | number | Yes      | New Leitner box level.                                  |

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

| Field          | Type   | Required | Description                                                                                        |
| -------------- | ------ | -------- | -------------------------------------------------------------------------------------------------- |
| `file`       | file   | Yes      | The issue`.zip` file. Must contain a root `.flashback` sidecar with `subscription` metadata. |
| `magazineId` | string | Yes      | Identifier for the magazine (used for deduplication and lookup).                                   |
| `targetPath` | string | No       | Destination folder path. Defaults to workspace root.                                               |

**Response** `201` — `{ ok: true }`.

**Errors** `400` file and magazineId required.

---

### `GET /api/subscriptions/:magazineId`

Returns the stored subscription record for a magazine.

| Param          | In   | Type   | Required | Description          |
| -------------- | ---- | ------ | -------- | -------------------- |
| `magazineId` | path | string | Yes      | Magazine identifier. |

**Response** `200` — `{ magazine_id, issue_id, version, target_path, ... }`.

**Errors** `404` subscription not found.

---

## Seal `/api/seal`

The Seal subsystem provides git-backed versioning of the canonical sidecar layer. Only `.flashback` sidecar files are tracked — the SQLite database is never committed.

### `GET /api/seal/log`

Returns recent Seal commits in reverse chronological order.

| Param     | In    | Type   | Required | Description                                         |
| --------- | ----- | ------ | -------- | --------------------------------------------------- |
| `limit` | query | number | No       | Maximum number of commits to return. Default`20`. |

**Response** `200` — array of `{ oid, commit: { message, author, ... } }` objects.

---

### `GET /api/seal/inspect`

Compares the current workspace against `HEAD` and returns uncommitted sidecar changes. Call this after a rollback to identify which database records need to be reconciled.

**Response** `200` — diff object with added, modified, and deleted sidecars since the last commit.

---

### `POST /api/seal/rollback`

Rolls the canonical sidecar layer back to a given commit. By default, SRS progress (card levels and ease factors) is snapshotted before the checkout and re-applied afterward so review history is not lost. Call `GET /api/seal/inspect` after rollback to reconcile the derived database layer.

| Field               | Type    | Required | Description                                              |
| ------------------- | ------- | -------- | -------------------------------------------------------- |
| `ref`             | string  | Yes      | Commit OID to roll back to (from`GET /api/seal/log`).  |
| `keepSrsProgress` | boolean | No       | Preserve SRS state across the rollback. Default`true`. |

**Response** `200` — `{ ok: true }`.

**Errors** `400` ref required.
