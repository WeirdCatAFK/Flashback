
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

**Anki packages are the exception**: an `.apkg` is *not* imported by this route. Anki notetypes have arbitrary named fields, so the route detects the package, runs `analyze` instead, and replies `200` with the analyze payload plus `needsMapping: true`. Follow up with `POST /api/documents/import/anki` carrying the returned `sessionId` and a mapping.

---

### `POST /api/documents/import/anki/analyze`

Reads an Anki `.apkg` **without importing anything** and reports what is inside it, so a client can ask the user which Anki field should fill which part of a Flashback card. **Multipart form data.**

| Field  | Type | Required | Description        |
| ------ | ---- | -------- | ------------------ |
| `file` | file | Yes      | The `.apkg` file. |

Handles all three package generations, including the zstd + protobuf format Anki has exported by default since 2.1.50.

**Response** `200`:

```json
{
  "sessionId": "…",
  "version": 3,
  "totalNotes": 142,
  "decks": [{ "id": "500", "name": "Japanese::Vocabulary", "noteCount": 142 }],
  "notetypes": [{
    "id": "1000",
    "name": "Japanese Recognition",
    "noteCount": 142,
    "fields": [{ "ord": 0, "name": "Expression", "description": "" }],
    "templates": [{ "ord": 0, "name": "Card 1" }],
    "suggested": { "cardType": "basic", "slots": { "front": ["Expression"], "back": ["Meaning"] } },
    "samples": [["食べる", "to eat"]]
  }]
}
```

`suggested` is read out of the notetype's own templates, so a well-formed deck needs no edits. `sessionId` keeps the extracted package on disk for an hour so the apply call needs no second upload.

**Errors** `400` file required.

---

### `GET /api/documents/import/anki/media`

Streams one asset out of a live `analyze` session, decompressed, so the mapping UI can show images and **play sounds before importing** — which is how the user decides whether a sound belongs with the question or with the answer. Read-only: nothing is written to the vault.

| Param       | Type   | Required | Description                                      |
| ----------- | ------ | -------- | ------------------------------------------------ |
| `sessionId` | string | Yes      | From `POST /import/anki/analyze`.                |
| `name`      | string | Yes      | The asset's **original Anki filename**, e.g. `taberu.mp3`. |

Loaded by `<img>`/`<audio>`, so it authenticates via `?token=` like the other media routes. `name` is matched against the session's media map and only the map's numeric zip key is ever joined to a path, so it can't address arbitrary files.

**Response** `200` — the raw asset bytes, `Content-Type` derived from the filename extension.

**Errors** `400` sessionId and name required; `404` asset not found in import session (also returned for an expired or malformed session).

---

### `POST /api/documents/import/anki`

Imports an Anki `.apkg` into decks as standalone cards. **Multipart form data.**

| Field        | Type   | Required | Description                                                                 |
| ------------ | ------ | -------- | --------------------------------------------------------------------------- |
| `file`       | file   | No\*     | The `.apkg` file.                                                           |
| `sessionId`  | string | No\*     | Reuse an `analyze` extraction instead of re-uploading.                       |
| `mapping`    | string | No       | JSON `{ [notetypeId]: { cardType, slots } }`.                                |
| `targetPath` | string | No       | Ignored — Anki notes become standalone cards, which have no workspace path. |

\* One of `file` or `sessionId` is required.

`slots` keys are `front`, `back`, `front_img`, `front_sound`, `back_img`, `back_sound`, each holding an array of Anki field names. Several fields may share a slot and concatenate in order; a field in a text slot keeps its text while media inside it still fills the matching media slot; a field in a media slot contributes only its first asset; a field in no slot is dropped. Notetypes the mapping omits fall back to the same suggestion `analyze` reported, so omitting `mapping` entirely is valid.

**Response** `201` — `{ ok: true, path: "Anki_Import_…", imported: 142 }`.

**Errors** `400` file or sessionId required; `400` mapping must be valid JSON.

### `POST /api/documents/youtube/transcript`

Fetches a `.youtube` document's captions from YouTube and stores them in the sidecar's `source` block (`source.transcript` = cues, `source.transcriptMeta` = `{ lang, kind, fetchedAt }`), making the video's spoken content readable via [`/api/reader`](#reader-apireader) and resolvable from its `video_timestamp` highlights. Metadata-only (the body descriptor is untouched); the change is versioned by Seal. The fetch scrapes YouTube's caption track — there is no local speech-to-text fallback.

| Field  | Type   | Required | Description                                                           |
| ------ | ------ | -------- | --------------------------------------------------------------------- |
| `path` | string | Yes      | Relative path to the `.youtube` document.                             |
| `lang` | string | No       | Preferred caption language code (e.g. `en`). Falls back to available. |

**Response** `200` — `{ path, cues, lang, kind }` (`kind` is `asr` for auto-generated captions, `manual` otherwise).

**Errors** `400` path required / no video id · `404` no such document · `422` the video has no usable captions.

---

## Reader `/api/reader`

Paginated, read-only **text extraction** for documents whose bodies are not decodable text (PDF, EPUB, saved web clips), plus character-window reads of ordinary text files. Built for the MCP server — which has no renderer and cannot receive bytes — but not restricted to it. Backed by [`access/mcpReader.js`](./access/ACCESS.md#mcpreaderjs); see there for the extraction rules and cache.

Addressing follows each format's **native unit**:

| Format | `unit` | Addressed by |
| --- | --- | --- |
| `.pdf` | `page` | `index` (1-based), `count` |
| `.epub` | `section` | `index` (1-based) **or** the spine href, `count` |
| `.youtube` *(with a fetched transcript)* | `segment` | `index` (1-based), `count`, **or** `at`=seconds |
| `.md` `.markdown` `.txt` `.text` `.clip` `.youtube` *(no transcript)* | `chars` | `offset`, `limit` |

A `.youtube` document only yields `segment` units once its captions have been fetched into the sidecar (see [`POST /api/documents/youtube/transcript`](#post-apidocumentsyoutubetranscript)); until then it reads as a short `chars` stub explaining how to fetch one.

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
| `at`         | query | number        | No       | `segment` unit (YouTube transcript): seconds to jump to — lands on the block covering that moment (e.g. a `video_timestamp` highlight's `start`). |

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

## Flashcards `/api/flashcards`

Single-card operations addressed by `globalHash`. Document-anchored cards live in their source document's sidecar and standalone cards in the system deck's JSON, but a caller holding a hash does not have to know which — `GET`, `PUT` and `DELETE` all resolve the card's home themselves. (Creation still differs: see `POST /api/media/vanilla` for document-anchored cards.)

### `GET /api/flashcards/:hash`

Resolves any card to its content plus `documentPath` (`null` for a standalone card), so a client can route an edit correctly.

**Response** `200` — `{ globalHash, name, cardType, level, origin, frontText, backText, customHtml, category, documentPath, media }`.

`media` is `{ front_img, back_img, front_sound, back_sound }` holding the card's **stored references** (e.g. `"./media/front-1a2b.png"`), not URLs — resolve them through `GET /api/media/file?docPath=…&name=…` before rendering.

**Errors** `404` card not found.

### `POST /api/flashcards`

Creates a **standalone** card in the system deck. Body: `{ frontText, backText, name, cardType, category, customHtml, origin }`. `origin: 'ai'` marks AI provenance and is set once at creation; anything else is dropped.

**Response** `201` — `{ globalHash }`. **Errors** `400` unknown category.

### `GET /api/flashcards/:hash/detail`

Everything the card detail view needs in one request: content, current schedule, the card's full review ledger and a sampled retention curve. Read-only.

**Query** `algorithm` (optional) — see the SRS section's note; omit it and the server infers the vault's scheduler and echoes back the one it used.

**Response** `200` —

```jsonc
{
  "card": { /* as GET /api/flashcards/:hash */ },
  "algorithm": "fsrs",
  "srs": {
    "state": "new" | "review",
    "level": 5, "sm2Reps": 4, "easeFactor": 2.5,
    "lastRecall": "…", "dueAt": "…", "intervalDays": 8, "overdueDays": 0,
    "fsrs": { "stability": 8.4, "difficulty": 5.1, "state": 2, "reps": 6, "lapses": 1 },
    "reviews": 6, "correct": 5, "lapses": 1, "retention": 0.83, "syntheticEntries": 0
  },
  "history": [ { "id": 1, "at": "…", "algorithm": "fsrs", "outcome": 1, "rating": 3,
                 "easeFactor": null, "level": 5, "stability": 8.4, "difficulty": 5.1,
                 "due": "…", "state": 2, "synthetic": false } ],
  "curve": { "model": "fsrs" | "approximated", "requestRetention": 0.9,
             "stabilityDays": 8.4, "originAt": "…", "dueAt": "…", "intervalDays": 8,
             "horizonDays": 16, "nowT": 5.2, "nowR": 0.94,
             "points": [ { "t": 0, "r": 1 }, "… 64 samples" ] },
  "flags": [
    { "id": "mouthful:42", "kind": "mouthful", "confidence": "high", "score": 0.9,
      "detectedAt": "…", "levelAtDetection": 1,
      "title": "Looks overloaded", "detail": "…",
      "action": "Split it into smaller cards", "actionKind": "split",
      "evidence": { "trajectory": "oscillating", "peaks": [4, 4, 2, 4], "peakSlope": -0.04,
                    "difficultySlope": 0.22, "memoryModel": "fsrs", "prior": "overloaded",
                    "answerTokens": 61, "medianAnswerTokens": 9, "lengthRatio": 6.78,
                    "chunks": 5, "lapses": 5, "windowDays": 44,
                    "repeatFailureInSession": false, "basis": "…" } }
  ]
}
```

Notes:

- `curve` is `null` for a card that has never been reviewed, and its `points` span the **last review → horizon** — it describes the card's present memory state, not a reconstruction of its history (that's what `history` is for).
- `model: "fsrs"` means the curve is `retrievability()` on the card's own stability with the vault's fitted weights — the same function that scheduled it. `model: "approximated"` means Leitner/SM-2, which have no memory model: the curve is drawn from `stability := the scheduled interval`, i.e. the scheduler's own premise that the interval is where recall has fallen to `requestRetention`. Clients must label the two differently.
- `history` includes the synthetic rows a vault rebuild writes (`synthetic: true`, no outcome); they are excluded from `reviews`/`correct`/`retention` and counted in `syntheticEntries`. Rows written before migration 006 report `algorithm: null` rather than a guess.
- `flags` is a **read**, never a computation: classification runs at review time and only on a card that has just failed (see `POST /api/srs/review`). Opening a card's detail view can never cause it to be accused of anything. `kind` is one of `mouthful`, `probe`, `overdue_drift`, `session_fatigue`; `evidence.memoryModel: "approximated"` means the vault's scheduler records no difficulty signal, so the verdict rests on intervals alone and its confidence is capped one step lower. Full semantics in `DATAMODEL.md` § Card Health.

**Errors** `404` card not found.

### `GET /api/flashcards/:hash/flags`

The card's live card-health flags and nothing else — the same array `/detail` returns under `flags`, without the review ledger and retention curve around it. Read-only; like `/detail`, it never runs the classifier.

Exists for callers that want to know *why* a card was flagged but have no use for its history — chiefly the MCP server, where the ledger would be a large payload spent to reach a four-element array.

**Response** `200` — `{ "flags": [ /* as in /detail */ ] }`. An unflagged card returns `{ "flags": [] }`.

**Errors** `404` card not found — deliberately distinguished from a card with no flags.

### `POST /api/flashcards/:hash/flags/:kind/dismiss`

The user has ruled on a card-health flag. Suppresses it (sets `dismissed_at`) rather than deleting it, so it stops re-announcing itself on every later failure while its evidence stays current. Only the named kind is affected — a card can carry both guards at once. Editing the card clears the suppression entirely.

**Response** `200` — `{ ok: true, flags }`, the card's remaining live flags.

**Errors** `400` unknown flag kind; `404` card not found, or the card carries no flag of that kind.

**Finding flagged cards vault-wide.** There is no separate inbox endpoint — the card browser carries the filter. `GET /api/decks/cards` accepts `flagged=1` (any live flag) and `flagKind=<kind>` (one signature, and it implies `flagged`), and every row in that listing returns a `flags` field: a comma-joined list of the card's live flag kinds, or `null`. `total` honours the filter, so the pager stays correct.

### `PUT /api/flashcards/:hash`

Updates a card of **either** kind. Partial — omitted fields keep their stored values. Body: `{ frontText, backText, name, cardType, category, customHtml, tags }`. For a document-anchored card the edit is applied to its sidecar entry server-side, preserving the card's SRS progress, media and highlight anchor, and emits a Seal commit; `tags` is ignored for standalone cards (they inherit theirs from their deck).

**Response** `200` — `{ ok: true, documentPath }`. `documentPath` is `null` for a standalone card.

**Errors** `400` unknown category; `404` card not found.

### `DELETE /api/flashcards/:hash`

Permanently deletes a card of **either** kind, along with its review history, and unlinks it from every deck holding it (canonical deck JSON and `DeckEntries` both — those key on `card_hash`, so nothing cascades on its own). For a document-anchored card the source document's body is untouched; only its sidecar's `flashcards[]` entry is removed. Both branches emit a Seal commit.

**Response** `200` — `{ ok: true, documentPath, decksTouched }`. `documentPath` is `null` for a standalone card.

**Errors** `404` card not found.

---

## SRS `/api/srs`

**The `algorithm` parameter.** Which scheduler (`leitner` | `sm2` | `fsrs`) the user reviews with is a browser preference (`localStorage` `fb-srs-algorithm`), so the app sends it explicitly on every request. It is **optional** on the read-only endpoints (`/due`, `/statistics`): when omitted, the server infers it from the vault's own review history — each `ReviewLogs` row records the scheduler that graded it (migration 006) — instead of falling back to a fixed default. Those responses echo the algorithm actually used in their `algorithm` field, so a caller with no browser (the MCP server) can trust what it reads back. A vault with no reviews yet has nothing to infer from and reports `leitner`.

### `POST /api/srs/review`

Submits a spaced-repetition review result for a flashcard. Updates the card's level and ease factor in both the sidecar and the database, and appends a review log entry.

| Field             | Type   | Required | Description                                             |
| ----------------- | ------ | -------- | ------------------------------------------------------- |
| `path`          | string | Yes      | Relative path to the document containing the flashcard. |
| `flashcardHash` | string | Yes      | `globalHash` of the flashcard.                        |
| `outcome`       | number | Yes      | Review outcome (`1` = correct, `0` = incorrect).    |
| `easeFactor`    | number | Yes      | Updated ease factor computed by the client.             |
| `newLevel`      | number | Yes      | New Leitner box level.                                  |

**Response** `200` — `{ ok: true, flags }`.

`flags` is the **card-health** result for this review, and it is the only place classification is triggered:

- A **failing** grade (`outcome: 0`, or FSRS `rating: 1`) classifies the card and returns any flags raised. There is no reason to guess at why a card is failing when it isn't, so a card that is passing is never analysed and never flagged.
- A **passing** grade returns `[]` always. If it carried the card to level ≥ 3 the card counts as recovered and its flags are cleared; below that nothing happens, because a badly-built card passes constantly at a one-day interval and treating any pass as success would make the flag unreachable.

The Trainer collects these and reports them once at the **end** of the session — a review is not the moment to argue with someone about how their card is built. Classification failures are logged and swallowed: a classifier bug must never cost the user a graded review that is already persisted.

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

Returns a page of Seal commits in reverse chronological order.

| Param      | In    | Type   | Required | Description                                                                                     |
| ---------- | ----- | ------ | -------- | ------------------------------------------------------------------------------------------------- |
| `limit`  | query | number | No       | Commits per page. Default`20`, clamped to`200` (each commit costs a tree diff).              |
| `cursor` | query | string | No       | Oid of the last commit already held; the page resumes**after** it. Omit for the newest page. |

**Response** `200` — array of `{ oid, commit: { message, author, ... }, stats }` objects.

`stats` is `{ added, modified, deleted, content }`: path counts for the commit's diff against
its parent, where `content` is how many of those paths are **not** `.flashback` sidecars. An
`edit` commit with `content: 0` changed metadata only — a highlight, a flashcard, a tag — which
is what lets the client say so instead of showing a raw sidecar path.

Paging is cursor-based because git history is a linked list, not an indexable array. A page
shorter than `limit` means history ended.

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
