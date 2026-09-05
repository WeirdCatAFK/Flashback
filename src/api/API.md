
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

`documents` · `reader` · `progress` · `media` · `flashcards` · `srs` · `subscriptions` · `seal` · `decks` · `highlights` · `categories` · `search` · `doctor` · `diary` · `vault` · `remotes` · `identity` · `accounts`

All request bodies are JSON unless marked **multipart**. All responses are JSON unless noted otherwise. Paths in request bodies or query strings may use forward slashes on any platform; the server normalizes them internally.

---

## Authentication and roles

Every `/api/*` request resolves to an **account** before it reaches a router. The `GET /` readiness ping stays open.

A token is presented as `Authorization: Bearer <token>` or, for browser-initiated loads that cannot set a header (PDF and media URLs, `<img>`/`<audio>`), as a `?token=` query parameter. It is looked up by SHA-256 hash against the accounts store (`{baseDir}/accounts.db`, outside every vault) and yields `req.account` = `{ id, name, email, role }`.

- **`401`** — `{ error: "Unauthorized: missing or invalid API token" }`. No token, an unknown one, a revoked one, or one belonging to a deactivated account. A revoked token fails *here*, not with a 403: it identifies nobody, so there is no role to compare.
- **`403`** — `{ error, required, role }`. Authenticated, but the role is not enough. The required role is named on purpose; without it a client cannot tell "you may not" from "this is broken".

With **no token configured at all** — the standalone `dev:api` / `dev:web` flows, which never run Electron, the only process that mints one — an anonymous caller is treated as the Author. That is how those flows have always worked. A server build sets `requireAuth`, which refuses anonymous callers and refuses to boot with no usable token.

Roles form a strict ladder: **reader** (study progress) < **collaborator** (+ annotates existing documents) < **admin** (+ modifies the vault, imports, manages access) < **author** (+ owns the files, holds the pure token). The full endpoint-by-endpoint policy is one table in `src/api/auth/permissions.js`; a router mounted without an entry there resolves to author-only, so the mistake fails closed. `tests/accounts.test.js` asserts the table covers every mounted router.

On a desktop install this is invisible: one Author account is provisioned from the local identity on first start, and the `apiToken` already in `config.json` is adopted as its token.

---

## Concurrent writes

Two people editing one vault must not silently overwrite each other. Two mechanisms, chosen so
that the common case stays free of false alarms.

**Whole-object writes carry a version.** `GET /api/documents/read` returns an `etag`; send it
back as `ifMatch` on `PUT /api/documents/file` or `/metadata`. If the document changed in
between, the write is refused:

```
409 { "error": "This document changed since you last read it.", "code": "stale", "etag": "…" }
```

Nothing was written, and the `etag` in the body is the current one, so a client can re-read and
retry without a second round trip to find out what it missed.

The etag is derived from the bytes on disk, never stored, so it is still right after a Vault
Doctor rebuild, a Seal rollback, or an edit made in another program. It has two halves —
`"<body>.<sidecar>"` — and **only the half a request replaces is compared**: a write carrying
`content` is checked against the body, a metadata-only write against the sidecar. That is what
lets an editor save while someone else adds a card to the same document; the editor merged that
sidecar from a fresh read moments earlier, and refusing it would be a conflict about a change it
had already incorporated.

**Omitting `ifMatch` skips the check entirely.** Deliberate: the MCP server, the test suite and
every script written before this send no version, and the single-writer desktop case they serve
has no conflict to detect. A server build makes it mandatory, because that is the first
configuration where a second writer exists.

**Patches merge instead of conflicting.** `POST|PUT|DELETE /api/flashcards/:hash` and the
`/api/highlights` routes name their target by `globalHash`. The server re-reads the sidecar,
applies the change to that entity and puts everything else back, so two people editing different
cards of one document both succeed. `ifMatch` on those routes is the **entity's** etag (returned
as `etag` by `GET /api/flashcards/:hash`), so the only thing that can conflict is two edits to
the same card.

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

**Response** `200` — `{ content, encoding, binary, size, metadata, etag }`.

`etag` is this document's **version** — send it back as `ifMatch` when you save and a write that lost a race is refused instead of silently overwriting whoever got there first. See [Concurrent writes](#concurrent-writes).

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
| `ifMatch`  | string | No       | The `etag` this document carried when you read it. |

**Response** `200` — `{ ok: true, etag }` — the version the write produced, to use as the next `ifMatch`.

A `content` write is accepted **only** for `.md` / `.markdown` / `.txt` / `.text` — the formats with an editable renderer in the app. Every other format is a viewer, so a body write to one can only come from outside the app, and bodies are not versioned by Seal (the overwrite is unrecoverable). Metadata-only writes are accepted on any document, which is how the PDF/EPUB renderers save their sidecars. Clip and YouTube bodies are written by their own endpoints, not here.

**Errors** `400` path required; `400` when `content` is present and the target is not an editable text format; `409 { error, code: 'stale', etag }` when `ifMatch` no longer matches — nothing was written, and the `etag` in the body is the current one. See [Concurrent writes](#concurrent-writes).

---

### `PUT /api/documents/metadata`

Updates only the sidecar metadata of a file or folder without touching its content.

| Field        | Type    | Required | Description                                          |
| ------------ | ------- | -------- | ---------------------------------------------------- |
| `path`     | string  | Yes      | Relative path to the item.                           |
| `metadata` | object  | Yes      | New metadata object.                                 |
| `isFolder` | boolean | No       | `true` if the path is a folder. Default `false`. |
| `ifMatch`  | string  | No       | The `etag` this sidecar carried when you read it.    |

**Response** `200` — `{ ok: true, etag }`.

**Errors** `409 { error, code: 'stale', etag }` — see [Concurrent writes](#concurrent-writes).

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

### `POST /api/documents/clip/asset`

Downloads one of a saved clip's remote pictures or sounds into the vault: the file lands in `media/` beside the clip as `clip-<hash>.<ext>`, the clip body's `src` is rewritten to `./media/<name>`, a `Media` row is registered, and the edit is sealed.

Clipping a page saves its prose and nothing else — every picture and sound keeps the URL it came from and loads from that host while reading. This endpoint is what makes one of them local, and it runs when a user puts that asset on a card. A clip therefore fills in over time with exactly the figures and sounds that were used.

| Field  | Type   | Required | Description                                                                        |
| ------ | ------ | -------- | ---------------------------------------------------------------------------------- |
| `path` | string | Yes      | Relative path to the `.clip` document.                                             |
| `href` | string | Yes      | The asset's `src`, exactly as it appears in the body (or as [`/api/reader/media`](#get-apireadermedia) reports it). |

**Response** `200` — `{ path, href, name, kind, bytes, mediaType, alreadySaved }`. `href` is the new `./media/<name>` reference. An href that is **already local** returns `alreadySaved: true` with no network IO, so a caller can call this unconditionally rather than first working out whether the asset was saved before.

**Errors** `400` path/href required, not a `.clip`, an href that is not a src in this clip, a `data:` src, the site refusing the file, or an asset over its size ceiling (10 MB image / 15 MB audio) · `404` no such document.

The href must already appear in that clip's body. That check is what keeps this from being a general-purpose downloader that writes any URL on the internet into the vault under the user's token.

---

### `GET /api/documents/tags`

Every tag name in the vault.

**Response** `200` — `{ tags }`.

---

### `GET /api/documents/tags/usage`

Every tag with how many entities carry it — the Manage tab's tag list.

**Response** `200` — `{ tags }`, each `{ name, count }`.

---

### `GET /api/documents/tags/entity`

The three-tier tag state of one file or folder. See `DATAMODEL.md` § Tags for why exclusion is
a stored fact rather than the absence of a tag.

| Param      | In    | Type    | Required | Description                                   |
| ---------- | ----- | ------- | -------- | --------------------------------------------- |
| `path`     | query | string  | Yes      | Relative path to the file or folder.          |
| `isFolder` | query | boolean | No       | `"true"` to resolve the path as a folder.     |

**Response** `200` — `{ direct, inherited, excluded }`. `direct` and `inherited` come from the
index; `excluded` is read from the sidecar, which is where it is canonical.

**Errors** `400` path required · `404` entity not found.

---

### `GET /api/documents/sidecar`

The raw `.flashback` sidecar for a file or folder, verbatim.

| Param      | In    | Type    | Required | Description                               |
| ---------- | ----- | ------- | -------- | ----------------------------------------- |
| `path`     | query | string  | Yes      | Relative path to the file or folder.      |
| `isFolder` | query | boolean | No       | `"true"` to resolve the path as a folder. |

**Response** `200` — the sidecar JSON as-is. The document's etag rides in the **`ETag` header**
rather than the body, because callers parse the body as the canonical format and an extra field
would look like part of it. Pass that value back as `ifMatch` on a write.

**Errors** `400` path required · `404` sidecar not found.

---

### `GET /api/documents/by-hash/:hash`

Resolves a `globalHash` to a location — how the renderer turns a clicked `flashback://` link
into a path to open.

| Param  | In   | Type   | Required | Description                 |
| ------ | ---- | ------ | -------- | --------------------------- |
| `hash` | path | string | Yes      | The document's `globalHash`. |

**Response** `200` — `{ relativePath, name }`.

**Errors** `404` Document not found.

---

### `POST /api/documents/links/sync`

Re-derives one document's `flashback://` link edges from its body. Writes are already synced on
save; this is the manual repair path.

**Body** `{ path }`.

**Response** `200` — `{ ok: true }`.

**Errors** `400` path required.

---

### `POST /api/documents/import/obsidian`

Imports an Obsidian vault as a zip, one document per note. See `DATAMODEL.md` for the
metadata-leakage rules (frontmatter, comments, tags, clozes).

**Body** `multipart/form-data` — `file` (the zip, required), `targetPath` (destination folder,
defaults to the workspace root).

**Response** `201` — the importer's result summary.

**Errors** `400` file required.

---

## Reader `/api/reader`

Paginated, read-only **text extraction** for documents whose bodies are not decodable text (PDF, EPUB, saved web clips), plus character-window reads of ordinary text files, plus the **media** those documents carry — an EPUB's figures, a clip's downloaded pictures and sound. Built for the MCP server — which has no renderer — but not restricted to it: the card form's media pickers are the other client of the media half. Backed by [`access/orchestration/mcpReader.js`](./access/ACCESS.md#mcpreaderjs); see there for the extraction rules and cache.

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

**Response** `200` — `{ path, format, unit, total, extractable, note?, sections?, images?, media? }`. `total` counts pages, sections, or characters depending on `unit`. `sections` lists `{ index, label, href, chars }` for EPUBs, and `images` is that EPUB's image *count*. For a clip, `media` is `{ total, images, audio }` — counts only, enough to know whether calling `/media` is worth it. `extractable: false` with a `note` means the file parsed but holds no text layer (a scanned PDF needing OCR).

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

### `GET /api/reader/images`

Every image an EPUB declares, in reading order — metadata only, no bytes. This is how a figure from a book becomes a flashcard's front: the picker (and the MCP server) chooses here, then fetches the one it wants.

| Param  | In    | Type   | Required | Description                |
| ------ | ----- | ------ | -------- | -------------------------- |
| `path` | query | string | Yes      | Relative path to the EPUB. |

**Response** `200` — `{ path, format, total, images: [{ index, href, name, mediaType, bytes, alt, caption, section, sectionIndex, isCover }] }`. `href` is how the image is addressed below. `sectionIndex` is the number to pass `/read` for the surrounding page, or `null` when the image sits on a page with no prose (a plate, a cover). Images no section references — a cover named only by metadata, leftover manifest assets — come last.

**Errors** `400` path required · `404` no such document · `415` not an EPUB (no other format has an extractable image list).

### `GET /api/reader/image`

One image's bytes, with its own content type. Loaded directly by `<img>` in the picker, so it accepts the `?token=` query param like the other browser-initiated media URLs.

| Param  | In    | Type   | Required | Description                                          |
| ------ | ----- | ------ | -------- | ---------------------------------------------------- |
| `path` | query | string | Yes      | Relative path to the EPUB.                           |
| `href` | query | string | Yes      | The image's `href` from `/images` (the full archive path, its bare file name, or the section-relative `src` — as long as exactly one image matches). |

**Response** `200` — the raw bytes, `Content-Type` from the manifest, `Cache-Control: private, max-age=3600`.

**Errors** `400` path/href required, no such image in the book, or an href matching more than one · `404` declared in the manifest but missing from the archive · `415` not an EPUB.

Only an href the OPF manifest declares as an **image** is served — that allow-list is what stops this being a way to read arbitrary entries out of the zip.

### `GET /api/reader/media`

Every asset a document carries, in document order — metadata only, no bytes. The general form of `/images`: it serves an **EPUB**'s figures and a **saved clip**'s pictures and sound alike, so one picker can browse either.

| Param  | In    | Type   | Required | Description                    |
| ------ | ----- | ------ | -------- | ------------------------------ |
| `path` | query | string | Yes      | Relative path to the document. |

**Response** `200` — `{ path, format, total, media: [{ index, kind, href, name, mediaType, bytes, alt, caption, … }] }`. `kind` is `"image"` or `"audio"`. A clip's sound reaches this list as either an `<audio>` element **or a link to an audio file** — most of the web, Wikipedia included, publishes sound as a link and has no `<audio>` anywhere, so a list built only from players would report such a page as silent. Links to MIDI, and to anything whose last path segment contains a colon (`File:Something.ogg` — a page *about* a sound), are excluded. The remaining fields follow the format:

| Field | EPUB | Clip |
| --- | --- | --- |
| `section` / `sectionIndex` / `isCover` | as `/images` reports them | absent |
| `heading` | absent | the last `h1`–`h6` before the asset, or `null` above the first |
| `cached` | always `true` | `false` until the asset is saved into the vault |
| `path` | always `null` — a figure lives inside the zip | the asset's real workspace-relative path once saved, so `/api/media` and MCP's `attach_media` can reach it |

A clip's assets start **uncached** — a fresh clip downloads no media at all — and an uncached entry's `href` is the remote URL it loads from. That is not a failure: the picture displays perfectly well from its own host, and [`POST /api/documents/clip/asset`](#post-apidocumentsclipasset) pulls it into the vault when it goes on a card. `cached` says which side of that line an asset is on, and therefore whether `/media-file` can serve its bytes.

**Errors** `400` path required · `404` no such document · `415` neither an EPUB nor a clip (no other format carries extractable media).

### `GET /api/reader/media-file`

One asset's bytes, with its own content type — the general form of `/image`, and what an `<audio src>` points at. Loaded directly by the browser, so it accepts the `?token=` query param.

| Param  | In    | Type   | Required | Description                                          |
| ------ | ----- | ------ | -------- | ---------------------------------------------------- |
| `path` | query | string | Yes      | Relative path to the document.                       |
| `href` | query | string | Yes      | The asset's `href` from `/media` (or its bare file name, as long as exactly one asset matches). |

**Response** `200` — the raw bytes, `Cache-Control: private, max-age=3600`.

**Errors** `400` path/href required, no such asset, an href matching more than one, or a clip asset not yet saved into the vault · `404` declared but missing from the archive or the vault · `415` format carries no media.

The same allow-list applies for both formats, and a clip asset still loading from the web is **refused, not fetched** — this endpoint does no network IO on a caller's behalf. Downloading one is [`POST /api/documents/clip/asset`](#post-apidocumentsclipasset)'s job, and it is a POST precisely because it reaches out to the network.

---

## Read progress `/api/progress`

Where the caller has read to in a document, and how far through a folder they are. Backed by [`access/orchestration/readProgress.js`](./access/ACCESS.md#readprogressjs).

**Every endpoint here is about the caller's own reading.** None takes an account parameter and none can reach anyone else's positions, which is why the whole mount sits at `reader` in the permission table: recording where you got to is not an administrative act, and a Reader who could not record one could not resume anything. Cross-person visibility, if it is ever wanted, belongs under `accounts` beside [`GET /api/accounts/:id/progress`](#get-apiaccountsidprogress), where an actor and a target can be compared.

Positions are stored in `accounts.db`, for **everyone including the owner**, keyed by `(vault_id, scope, document globalHash)`. This is deliberately not the split SRS makes, and the two reasons are specific to reading: a position moves continuously, so sidecar storage would turn reading into a commit stream; and a Reader cannot write a sidecar at all, since `PUT /api/documents/metadata` is `collaborator`-gated. **Recording a position writes no file and produces no Seal commit.** The trade-off is that positions do not travel with a copied vault folder — the same bargain the access list and every reader's schedule already make. See `DATAMODEL.md` § Read progress.

A position is a `unit` plus a format-specific locator, in the **same vocabulary the reader paginates by**, so a stored position can bound a text read:

| Format | `unit` | Locator | Addresses `/api/reader/read` with |
| --- | --- | --- | --- |
| `.pdf` | `page` | `{ page }` | `index` |
| `.epub` | `section` | `{ cfi, href, section }` | `index`=`href` |
| `.md` `.markdown` `.txt` `.text` `.clip` | `chars` | `{ offset }` | `offset` |
| `.youtube` | `segment` | `{ seconds }` | `at` |

`total` is always supplied by the caller and never computed server-side: deriving it would mean a full extraction per document, so a folder listing would parse every PDF in it. A position with no `total` is still a valid resume point; it simply has no percentage.

**One document, one percentage scale — and `section` is the exception that proves it.** For `page`, `chars` and `segment` the locator and the percentage are the same scale, so an omitted `percent` is derived as `locator / total`. For `section` it is **not derived at all**, and an EPUB that sends no `percent` stores none. Three different vocabularies are in play there: `position.section` is epub.js's *spine* index (which counts covers, nav documents and blank pages), `/api/reader` numbers only the sections that carry text, and the percentage the renderer sends is weighted by how much text is actually behind you. None converts into another without the book open.

Deriving one anyway is what put two scales in one column: while epub.js builds its locations index it has no percentage to report, the gap was filled with a spine ratio, and since `auto` may only ever advance the furthest mark, that inflated figure then rejected every honest report behind it — a book 22% through its prose stuck at 48%. A missing percentage is the honest answer; the position still resumes, and `readingBound` falls back to the locator when the reader's unit matches the stored one.

**Finished** is derived, not stored: `furthestPercent >= 0.95`. Real documents end in indices and back matter nobody reads, so requiring 1.0 would leave finished books permanently at 99%; a manual write of 1.0 always clears the bar.

### `GET /api/progress`

Where the caller has read to in one document.

| Param  | In    | Type   | Required | Description                    |
| ------ | ----- | ------ | -------- | ------------------------------ |
| `path` | query | string | Yes      | Relative path to the document. |

**Response** `200` — `{ unit, total, position, percent, furthest, furthestPercent, finished, stale, updatedAt }`, or `null` when the caller has never opened it. A missing record means *never started*; it is never backfilled to a zero position.

`stale` is `chars`-only and means the body has been edited since the offset was measured: the percentage is kept, the now-meaningless absolute `offset` is dropped from `position`/`furthest`. Page and section positions do not drift.

**Errors** `400` path required · `404` no document indexed at that path.

---

### `PUT /api/progress`

Records a position.

| Field      | Type   | Required | Description                                                                 |
| ---------- | ------ | -------- | --------------------------------------------------------------------------- |
| `path`     | string | Yes      | Relative path to the document.                                              |
| `unit`     | string | Yes      | `page` \| `section` \| `chars` \| `segment`.                                |
| `position` | object | Yes      | Format-specific locator (see the table above).                              |
| `percent`  | number | No       | 0–1. Derived from `position`/`total` when omitted — except for `section`, which is never derived (see above). |
| `total`    | number | No       | Denominator in `unit`. Retained from the previous write when omitted.       |
| `mode`     | string | No       | `auto` (default) or `manual`.                                               |

`mode` is the whole auto-versus-manual rule and the only thing that decides the furthest mark:

- **`auto`** always moves `position`, and advances `furthest` *only forward* — scrolling back to check something never costs you your place.
- **`manual`** sets both, and **may move `furthest` backwards**. An explicit "I actually only got to page 20" has to be obeyable, or the mark can never be corrected. "Mark as finished" is a manual write of `percent: 1`.

**Response** `200` — `{ ok: true, progress }`, `progress` in the shape of `GET /api/progress`.

**Errors** `400` path required, unknown unit, missing position, or unknown mode · `404` no document indexed at that path · `409` the document has no `globalHash` to key a position to.

---

### `DELETE /api/progress`

Forgets the caller's position in one document.

| Param  | In    | Type   | Required | Description                    |
| ------ | ----- | ------ | -------- | ------------------------------ |
| `path` | query | string | Yes      | Relative path to the document. |

**Response** `200` — `{ ok: true }`. **Errors** `400` path required · `404` no such document.

---

### `GET /api/progress/reading`

What the caller is partway through, most recently touched first.

| Param             | In    | Type    | Required | Description                                     |
| ----------------- | ----- | ------- | -------- | ----------------------------------------------- |
| `limit`           | query | number  | No       | Maximum documents to return. Default 50.        |
| `includeFinished` | query | boolean | No       | Include finished documents. Default `false`.    |

**Response** `200` — an array of `{ path, name, globalHash, ...progress }`. Positions whose document has since been deleted are skipped, never dropped from the store.

---

### `GET /api/progress/list`

One folder listing's worth of progress, in a single call — the shape the file explorer draws a level from.

| Param     | In    | Type     | Required | Description                                                      |
| --------- | ----- | -------- | -------- | ---------------------------------------------------------------- |
| `folder`  | query | string   | No       | Folder to list. Defaults to the workspace root.                  |
| `folders` | query | string[] | No       | Subfolders to roll up, repeated once per folder.                 |

**Response** `200` — `{ documents, folders }`. `documents` is keyed by document `globalHash`; `folders` is keyed by folder path and holds a rollup each.

Mirrors `listFolder`, which already returns a descendant-aggregated `flashcardCount` for folders as well as files — so the explorer renders one level at a time and never issues a request per node.

---

### `GET /api/progress/rollup`

How far through a folder the caller is.

| Param  | In    | Type   | Required | Description                                        |
| ------ | ----- | ------ | -------- | -------------------------------------------------- |
| `path` | query | string | No       | Folder path. Defaults to the workspace root.       |

**Response** `200` — `{ path, total, finished, inProgress, unread, percent, subscription? }`.

Counting rules, all of which follow from *finished* being derived:

- **finished** — furthest `>= 0.95`
- **inProgress** — a position exists and is not finished
- **unread** — no position at all
- **percent** — the mean across *every* document in the subtree, counting unread as 0, so the number describes the folder rather than only the parts already touched
- a document with no denominator counts as `inProgress` and never as `finished`, and stays in `total`; dropping it would flatter the percentage

`subscription` is present when the folder is a subscription's `target_path`, and carries `{ magazineId, issueId }`. That label is the whole of what a "subscription rollup" is: `Subscriptions` records what a publisher installed and is not account-scoped, so per-person progress over its folder is the only place that answer can come from — the label turns "12 of 47 documents" into "12 of 47 issues".

---

### `GET /api/progress/coverage`

What the caller has read but has no flashcards for — the gap between the furthest mark and the deepest carded position.

| Param  | In    | Type   | Required | Description                    |
| ------ | ----- | ------ | -------- | ------------------------------ |
| `path` | query | string | Yes      | Relative path to the document. |

**Response** `200` — `{ path, unit, total, readTo, readPercent, cardedTo, cardedPercent, cards, gap, gapKnown }`.

`gap` is `{ from, to }` or `null`, and `gapKnown` separates the two reasons it can be null: cards already reach the mark, or the carded depth could not be determined. With no cards at all the gap is everything read so far (`from: 0`) — "nothing carded yet" is not the same answer as "nothing left to card".

Cards are vault-wide — only *schedules* are personal — so `cardedTo` is not scoped to the caller. It is read from the sidecar rather than from `FlashcardReference`, because a highlight-anchored card keeps its position on the highlight and the sidecar holds both.

`cardedTo` is `null` for `section` units: an EPUB card is anchored by CFI, and CFIs are not orderable without epub.js resolving them against the live book. Reporting "unknown" is the honest answer; inferring an ordinal from a CFI string is not.

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

**Response** `200` — `{ globalHash, name, cardType, level, origin, frontText, backText, answerText, customHtml, category, documentPath, media }`.

`answerText` is `type_answer`-only: the value the Trainer compares to what the user types, which leaves `backText` free for notes shown after checking. It is `null` on every other card type — and on a `type_answer` card written before the split, whose answer is still in `backText` (see DATAMODEL.md § Backward compatibility).

`media` is `{ front_img, back_img, front_sound, back_sound }` holding the card's **stored references** (e.g. `"./media/front-1a2b.png"`), not URLs — resolve them through `GET /api/media/file?docPath=…&name=…` before rendering.

**Errors** `404` card not found.

### `POST /api/flashcards`

Creates a **standalone** card in the system deck. Body: `{ frontText, backText, answerText, name, cardType, category, customHtml, origin }`. `origin: 'ai'` marks AI provenance and is set once at creation; anything else is dropped.

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

Updates a card of **either** kind. Partial — omitted fields keep their stored values. Body: `{ frontText, backText, answerText, name, cardType, category, customHtml, tags }` (`answerText` is stored only on `type_answer` cards and dropped on any other type). For a document-anchored card the edit is applied to its sidecar entry server-side, preserving the card's SRS progress, media and highlight anchor, and emits a Seal commit; `tags` is ignored for standalone cards (they inherit theirs from their deck).

**Response** `200` — `{ ok: true, documentPath }`. `documentPath` is `null` for a standalone card.

**Errors** `400` unknown category; `404` card not found.

### `DELETE /api/flashcards/:hash`

Permanently deletes a card of **either** kind, along with its review history, and unlinks it from every deck holding it (canonical deck JSON and `DeckEntries` both — those key on `card_hash`, so nothing cascades on its own). For a document-anchored card the source document's body is untouched; only its sidecar's `flashcards[]` entry is removed. Both branches emit a Seal commit.

**Response** `200` — `{ ok: true, documentPath, decksTouched }`. `documentPath` is `null` for a standalone card.

**Errors** `404` card not found.

---

## SRS `/api/srs`

**Every endpoint here is about the caller's own studying.** Progress, review history, card-health verdicts and fitted FSRS weights are all scoped to the account the request authenticated as (`'owner'` when that account is the Author — see `DATAMODEL.md` § Per-user progress). No endpoint takes an account parameter and none can reach anyone else's schedule: two people reviewing the same card diverge, and one person's grade never moves another's due list or retention numbers.

Two consequences worth stating outright:

- **A non-owner's review writes no file and produces no Seal commit.** Their schedule is durable in the accounts store instead. Reading is not editing, and a reader's study record must not be sealed into a git history that travels with a copy of the vault.
- **`POST /optimize` is reader-level, not admin-level.** Fitted FSRS weights model one individual's forgetting curve and are stored per account, so refitting them changes nothing anyone else can see. It was an administrative action only while the weights were a single shared row per vault.

**The `algorithm` parameter.** Which scheduler (`leitner` | `sm2` | `fsrs`) the user reviews with is a browser preference (`localStorage` `fb-srs-algorithm`), so the app sends it explicitly on every request. It is **optional** on the read-only endpoints (`/due`, `/statistics`): when omitted, the server infers it from the vault's own review history — each `ReviewLogs` row records the scheduler that graded it (migration 006) — instead of falling back to a fixed default. Those responses echo the algorithm actually used in their `algorithm` field, so a caller with no browser (the MCP server) can trust what it reads back. A vault with no reviews yet has nothing to infer from and reports `leitner`.

### `POST /api/srs/review`

Submits a spaced-repetition review result for a flashcard. Updates the caller's level and ease factor for that card and appends a review log entry stamped with their account.

The sidecar is written **only when the caller is the vault's Author** — the sidecar is the owner's record of the owner's progress. Every other account's schedule is mirrored into the accounts store (`AccountProgress`) inside the same transaction, so their review is just as durable while producing no file write and no Seal commit.

| Field             | Type   | Required | Description                                             |
| ----------------- | ------ | -------- | ------------------------------------------------------- |
| `path`          | string | Yes      | Relative path to the document containing the flashcard. |
| `flashcardHash` | string | Yes      | `globalHash` of the flashcard.                        |
| `outcome`       | number | Yes      | Review outcome (`1` = correct, `0` = incorrect).    |
| `easeFactor`    | number | Yes      | Updated ease factor computed by the client.             |
| `newLevel`      | number | Yes      | New Leitner box level.                                  |
| `sessionId`     | string | No       | Session this review belongs to, from `GET /due`.        |
| `sessionPosition` | number | No     | 0-based index of this review within the session.        |
| `prevCardHash`  | string | No       | `globalHash` of the card **actually shown** immediately before this one. |

The last three are **session-ordering telemetry** and are optional: omit them (the MCP server, a script, the Flashcards view) and the review is logged with no ordering context. When `sessionId` is present the server derives `prev_distance` and `nearest_sibling_lag` itself via `sequencer.measureOrdering()` — the client sends only what it displayed, never a distance. `prevCardHash` is what was *actually* presented rather than what the sequencer planned, so a card re-queued after a failed grade is measured where it really landed. See `DATAMODEL.md` § ReviewLogs.

**Response** `200` — `{ ok: true, flags }`.

`flags` is the **card-health** result for this review, and it is the only place classification is triggered:

- A **failing** grade (`outcome: 0`, or FSRS `rating: 1`) classifies the card and returns any flags raised. There is no reason to guess at why a card is failing when it isn't, so a card that is passing is never analysed and never flagged.
- A **passing** grade returns `[]` always. If it carried the card to level ≥ 3 the card counts as recovered and its flags are cleared; below that nothing happens, because a badly-built card passes constantly at a one-day interval and treating any pass as success would make the flag unreachable.

The Trainer collects these and reports them once at the **end** of the session — a review is not the moment to argue with someone about how their card is built. Classification failures are logged and swallowed: a classifier bug must never cost the user a graded review that is already persisted.

**Errors** `400` all fields required.

---

### `GET /api/srs/due`

Returns the cards to study now, **already in presentation order**.

| Param           | Type   | Description                                                        |
| --------------- | ------ | ------------------------------------------------------------------ |
| `algorithm`   | string | `leitner` \| `sm2` \| `fsrs`. Optional — inferred when omitted.  |
| `maxNew`      | number | New cards to introduce this session.                               |
| `minPriority` | number | Only cards whose pedagogical category priority ≥ this.            |
| `folder`      | string | Restrict to a folder subtree.                                      |
| `document`    | string | Restrict to one document.                                          |
| `deck`        | string | Restrict to a deck's cards.                                        |
| `tag`         | string | Restrict to a tag — **direct or inherited**. Repeatable.           |
| `excludeFolder`   | string | Hold back a folder subtree. Repeatable.                        |
| `excludeDocument` | string | Hold back one document. Repeatable.                            |
| `excludeDeck`     | string | Hold back a deck's cards, by `globalHash`. Repeatable.         |
| `excludeTag`      | string | Hold back cards carrying this **effective** tag. Repeatable.   |
| `read`        | string | `only` — offer only cards drawn from material the caller has read past. |
| `order`       | string | `interleaved` (default) \| `shuffle` \| `priority`.             |
| `seed`        | number | Fixed PRNG seed — reproduces a session exactly. Tests and bug reports. |

**Response** `200` — `{ queue, sessionId, order, relaxation, due, new, counts, nextDue, algorithm }`.

`queue` is the ordered session and is what a trainer should consume; **do not re-sort it**. `due` and `new` remain for callers that only want counts or bucket membership. `relaxation` reports which rung of the degradation ladder this session settled on (`none` | `no-folder-edge` | `short-lag` | `shuffle`), so an odd-looking order can be diagnosed without reproducing the vault.

Selection and sequencing are composed here but never folded together: the scheduler picks *which* cards from due dates alone, then the sequencer picks *what order*. Topology never moves a card across days. Full model in `DATAMODEL.md` § Session Sequencing.

`tag` matches a card's **effective** tags — direct ones plus those inherited from its folder, document or deck (`InheritedTags`, already exclusion-resolved). Matching direct tags only would make the filter select nothing for almost every tag the picker offers, since tags are normally applied to containers rather than to individual cards. `excludeTag` is the same expression negated, for the same reason and more urgently: the user is asking for something to be *gone*, and a direct-only match would show it to them anyway.

**Every exclusion keeps standalone cards.** A card with no document is in no folder and in no
document, so it cannot be in an excluded one. This is not symmetric with the positive filters,
which drop document-less cards on purpose: "cards in this folder" excludes them, "cards not in
this folder" plainly includes them. (In SQL the trap is that `NULL NOT IN (…)` is never true, so
the naive predicate would delete every standalone card in the vault along with the exclusion.)

`read=only` gates the session on **read progress** (`DATAMODEL.md` § Read progress). Two rules,
and the asymmetry between them is the whole policy:

- A document the caller has **never opened** contributes nothing at all.
- Inside a document they have opened, a card is held back only when its anchor is **provably**
  ahead of their furthest mark. A card whose position cannot be resolved — an EPUB CFI, a
  Markdown inline highlight, a card with no anchor — stays in the session, as does every
  standalone card. The gate hides work it can prove you have not reached, never work it merely
  cannot locate.

Nothing is rescheduled: a held-back card is not offered *this session* and reappears the moment
the flag comes off. Both the exclusions and the gate are applied during **selection**, so
`maxNew` still fills from eligible cards rather than from whichever of the first `maxNew`
happened to survive.

---

### `GET /api/srs/stats`

Returns the Leitner box distribution across the whole workspace, plus the mastery summary of
it. Scoped to the caller: the boxes come from `COALESCE(CardProgress.level, 0)`, so a card this
person has never reviewed is in box 0 rather than absent.

**Response** `200` — `{ boxes: [{ level, count }], total, mastered, masteryLevel, masteryPercentage }`.

`mastered` counts the caller's cards at `masteryLevel` (5) or above; `total` counts every card
in the vault, so `masteryPercentage` is a share of the whole vault rather than of the part
already studied. **Not the same question as `completeness.known` on `/api/srs/statistics`**,
which grades each card 0..1 from FSRS stability — this one is a binary cutoff and exists to
summarise the histogram it is served with.

### `POST /api/srs/undo`

Reverses a card's most recent review — the misgrade escape hatch. Removes the last `ReviewLogs`
row and restores the schedule that preceded it. `path` is present for a document-anchored card
so the sidecar is corrected too, and omitted for a standalone one, exactly as on `/review`.
Card health is re-evaluated afterward, because the retracted grade may be the one that raised a
flag; that re-classification is best-effort and never fails the undo.

| Field           | Type   | Required | Description                          |
| --------------- | ------ | -------- | ------------------------------------ |
| `flashcardHash` | string | yes      | `globalHash` of the card.            |
| `path`          | string | no       | Source document, for anchored cards. |
| `algorithm`     | string | no       | `leitner` \| `sm2` \| `fsrs`.        |

**Response** `200` — `{ ok: true, restored }`.
**Errors** `400` `flashcardHash` missing · `404` card or review not found.

### `POST /api/srs/migrate`

Translates **the caller's** progress from one algorithm's scale to the other by interval
matching, so the schedule is preserved as closely as the two models allow.

**Body** `{ from, to }` — both required, both one of `leitner` / `sm2` / `fsrs`, and they must
differ.

**Response** `200` — `{ ok: true, count }`, the number of cards remapped.
**Errors** `400` missing, equal, or unrecognized algorithm.

### `POST /api/srs/optimize`

Fits FSRS weights from **the caller's own** rated review history and persists them to their
`FsrsParameters` row. A no-op below the minimum-data threshold. No body. Reader-level: fitted
weights model one person's forgetting curve, so refitting them changes nothing anyone else sees.

**Response** `200` — `{ ok: true, ... }` including before/after loss and the review count used.

### `GET /api/srs/fsrs-info`

Optimizer status for the Config panel: how many rated reviews exist, whether weights have been
fitted, and when.

**Response** `200` — `{ ratedReviews, fitted, fittedAt, ... }`.

### `GET /api/srs/statistics`

Vault-wide analytics for the Stats view, scoped to the caller: retention, acquisition, maturity,
due forecast, activity heatmap, streaks and completeness. Retention counts only reviews past a
card's learning phase — the learning phase is reported separately under `acquisition`, rather than
being averaged into a number that would then flatter every vault with new cards in it. Read-only.

| Param       | Type   | Required | Description                                   |
| ----------- | ------ | -------- | --------------------------------------------- |
| `algorithm` | string | no       | Defaults server-side via `detectAlgorithm()`. |

**Response** `200` — the statistics object.

#### `completeness` — how far through the vault the caller is

**Not `acquisition`.** The two sit side by side and mean different things: `acquisition` is about
the *learning phase of a review* (first-exposure hit rate, retention over a card's first few reps),
while `completeness` is about *the vault* — how much of it has been read, and how well the cards
drawn from it are known.

```
completeness: {
  percent,                                          // 0..1, or null when the vault is empty
  read:  { percent, documents, finished, inProgress, unread },
  known: { percent, cards, mature, young, new }
}
```

- `read` is `readProgress.rollup('')` verbatim — the mean furthest-read fraction across **every**
  document, an unread one counting as 0.
- `known` is `SUM(learned) / COUNT(cards)` over every card in the vault, where `learned` is the
  same per-card 0..1 score GraphView paints (`query.js`'s `CARD_LEARNED_SQL`: FSRS stability when
  present, else `level/6` capped at 1). A card with no `CardProgress` row scores 0 rather than
  leaving the denominator.
- `percent` is the mean of the two halves — but **a half with an empty denominator is dropped
  rather than counted as zero**. A vault of standalone cards has nothing to read, and scoring it
  0% read would be a statement about material that does not exist; the same goes for a reference
  vault carrying no cards. With both empty, `percent` is `null`.

Composed at the route rather than inside `SRS.getStatistics()`: the two halves come from different
orchestrators, and `srs.js` may not import `readProgress.js` — that would pull `files.js` into the
scheduler, which is what "srs.js never imports documents.js" exists to prevent.

---

## Decks `/api/decks`

User-curated card collections. Canonical storage is `workspace/_decks/<uuid>.json` (Seal-tracked)
with `Decks`/`DeckEntries` mirroring it in the index; the JSON is written first and rolled back if
the database write fails. One deck is flagged `is_system` and is the home for every standalone
(document-less) card — it cannot be deleted.

**Roles:** `GET` is Reader; every write is Admin.

Errors are normalized by this router: a duplicate entry is `409`, an unknown deck or card `404`,
an attempt on the system deck `403`, and a raw filesystem error is replaced with a generic `500`
so an absolute path or a username never reaches a client.

### `GET /api/decks`

**Response** `200` — array of decks.

### `POST /api/decks`

**Body** `{ name, description? }`.
**Response** `201` — `{ globalHash }`. **Errors** `400` `name` missing.

### `GET /api/decks/cards`

The vault-wide card browser, and the only listing that spans decks and documents together. Also
where flagged cards are found — there is no separate inbox, deliberately, so flagged cards stay
in the one place cards are already hunted down. Every row carries `flags`: a comma-joined list of
the card's live flag kinds, or `null`. `total` honours the filter, so the pager stays correct.

| Param      | Type   | Description                                                                                              |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `search`   | string | Substring over name and content.                                                                          |
| `level`    | int    | Exact SRS level.                                                                                           |
| `cardType` | string | `basic` \| `reversible` \| `cloze` \| `type_answer` \| `custom`.                                           |
| `origin`   | string | `ai` (AI-created only) or `human` (everything else). Anything else is ignored.                             |
| `flagged`  | bool   | `1`/`true` — only cards carrying a live card-health flag.                                                  |
| `flagKind` | string | One signature; implies `flagged`. Unrecognized kinds are ignored rather than refused.                      |
| `sortBy`   | string | `level` (default) \| `name` \| `last_recall` \| `lapses` \| `difficulty`. The last two are FSRS-only and NULL for cards never rated under it; `difficulty` sinks those to the bottom in **both** directions. |
| `sortDir`  | string | `asc` \| `desc` (default).                                                                                 |
| `limit`    | int    | Default 50, capped at 200.                                                                                 |
| `offset`   | int    | Default 0.                                                                                                 |

**Response** `200` — `{ cards, total, limit, offset }`.

### `GET /api/decks/:hash` · `PUT /api/decks/:hash`

Read one deck, or update `{ name?, description? }`.
**Response** `200` — the deck, or `{ ok: true }`.

### `DELETE /api/decks/:hash`

Removes **the deck only**. Its cards survive as standalone cards in the system deck.
**Response** `200` — `{ ok: true }`.

### `GET /api/decks/:hash/contents`

What erasing this deck *and its cards* would destroy: counts split by standalone vs
document-anchored, plus how many of them another non-system deck also holds. Read-only, and it
exists so a client can say exactly what it is about to delete instead of guessing.

**Response** `200` — `{ standalone, anchored, shared, ... }`.

### `POST /api/decks/:hash/purge`

Deletes the deck **and its cards**. A separate route rather than a flag on `DELETE /:hash`, so the
non-destructive delete can never become destructive by accident. Cards go first: card deletions
seal through the debounced `edit()`, and the deck's `delete()` then flushes them, so the whole
erase lands in one commit instead of one per card.

**Body** `{ includeShared?: boolean }` — when false (default), a card another non-system deck also
holds is kept.
**Response** `200` — `{ ok: true, deleted, kept }`.

### `PUT /api/decks/:hash/tags`

**Body** `{ tags: string[] }` — replaces the deck's tags, which flow down to its member cards.
**Response** `200` — `{ ok: true, tags }`.

### `POST /api/decks/:hash/entries` · `DELETE /api/decks/:hash/entries/:cardHash`

Add or remove one card. **Body** on add: `{ cardHash, documentPath?, inlineCard? }` —
`inlineCard` is the content snapshot that lets a rebuild restore a document-less card from files
alone.
**Response** `201` / `200` — `{ ok: true }`. **Errors** `400` `cardHash` missing · `409` already in
deck.

---

## Highlights `/api/highlights`

A highlight is a first-class entity — its own `Highlights` row and its own entry in the document's
sidecar — independent of any flashcard; a card optionally *anchors* to one. **Roles:** `GET` is
Reader, every write is Collaborator, because highlights are the annotation surface and a
collaborator who could not write one could not annotate anything.

These routes are **patches**: they name their target by `globalHash`, re-read the sidecar under the
path lock and put back what they were not asked to change, so two people editing different
highlights of one document both succeed. An `ifMatch` here is the *entity's* etag, not the
document's.

### `GET /api/highlights`

**Query** `path` (required).
**Response** `200` — `{ highlights }`. **Errors** `400` `path` missing.

### `GET /api/highlights/annotated`

Highlights enriched with the highlighted text, ~200 chars of surrounding body context (for `.md`
/`.txt`, via `files.readFile`), and the flashcards already anchored to each one. Vault-wide when
`path` is omitted — this is what drives the "loose pages" review of what has been marked but not
yet turned into a card.

| Param      | Type   | Description                                      |
| ---------- | ------ | ------------------------------------------------ |
| `path`     | string | Restrict to one document. Omit for vault-wide.   |
| `color`    | string | Restrict to one highlight color.                 |
| `uncarded` | bool   | `true`/`1` — only highlights with no card on them. |
| `limit`    | int    | Default 100, capped at 500.                      |

**Response** `200` — `{ highlights, total }`. `total` is the unsliced count.

### `POST /api/highlights`

**Body** `{ path, type, start, end, page, bbox, color, note }` — which anchoring fields apply
depends on `type` (see `DATAMODEL.md`).
**Response** `201` — `{ ok: true, highlight }`. **Errors** `400` `path` missing.

### `PUT /api/highlights/:hash`

**Body** `{ path, color, note, ifMatch? }`.
**Response** `200` — `{ ok: true, highlight }`.
**Errors** `400` `path` missing · `409` `{ code: 'stale' }` when `ifMatch` no longer matches.

### `DELETE /api/highlights/:hash`

**Query** `path` (required).
**Response** `200` — `{ ok: true }`. **Errors** `400` `path` missing.

---

## Categories `/api/categories`

Editable pedagogical categories, managed in the Manage tab. A category carries a `priority` that
`GET /api/srs/due?minPriority=` filters on. **Roles:** `GET` is Reader; writes are Admin.

### `GET /api/categories`

**Response** `200` — array of `{ id, name, priority, description }`.

### `POST /api/categories`

**Body** `{ name, priority?, description? }`. `name` is trimmed and required.
**Response** `201` — `{ id }`. **Errors** `400` `name` missing or blank.

### `PUT /api/categories/:id`

**Body** `{ name?, priority?, description? }` — omitted fields keep their stored values.
**Response** `200` — `{ ok: true }`.

### `DELETE /api/categories/:id`

Refuses while any card still uses the category, rather than orphaning cards or silently
reassigning them.

**Response** `200` — `{ ok: true }`.
**Errors** `409` — `{ error: "In use by N flashcard(s)" }`.

---

## Search `/api/search`

One route, two modes. **Roles:** Reader (read-only by construction).

Search hits carry each card's level, so results are **the caller's** view of the vault. This route
reaches `query.js` directly instead of going through an orchestrator, which makes it one of the few
places that has to name the scope itself.

### `GET /api/search`

| Param      | Type   | Description                                                      |
| ---------- | ------ | ---------------------------------------------------------------- |
| `q`        | string | Free-text query. Alone, this selects **global mode**.             |
| `tag`      | string | Filter by tag name.                                              |
| `deck`     | string | Filter by deck `globalHash`.                                     |
| `document` | string | Filter by document path. Normalized — a POSIX-style path from an MCP tool or a script matches the backslash-separated paths in the index. |
| `folder`   | string | Filter by folder subtree. Normalized the same way.               |
| `limit`    | int    | Default 20, capped at 100.                                       |

- **Global mode** (`q`, no filters) → `{ folders, documents, flashcards, tags, decks }`.
- **Filter mode** (any of `tag`/`deck`/`document`/`folder`) → `{ flashcards }` matching *all*
  supplied filters.

**Errors** `400` — neither `q` nor any filter was supplied.

---

## Doctor `/api/doctor`

The Vault Doctor re-derives the SQLite index from the canonical files. It is **read-only toward
disk**: it never writes document content and never regenerates a `globalHash`. It also never
touches `accounts.db` — there is no canonical form of an account, so a rebuild there would delete
every token in the deployment.

**Roles:** `GET /check` is Admin (diagnosis is an audit power); `sync` and `rebuild` are Author,
because they rewrite the derived layer and a rebuild discards review history.

### `GET /api/doctor/check`

Read-only whole-vault consistency report — index vs. canonical files, plus deck diagnostics.

**Response** `200` — the report.

### `POST /api/doctor/sync`

Applies the check report, with **disk as truth**.

**Body** `{ sealDrift?: boolean }` — default `true`, binding the out-of-band changes it reconciled
into a single `reconcile:` Seal commit.
**Response** `200` — `{ ok: true, ... }`.

### `POST /api/doctor/rebuild`

Wipes the index and re-indexes the canonical layer from scratch.

**Destructive.** `ReviewLogs` and everything derived from it — review history, card-health verdicts,
optimizer input — do not survive, because no canonical file holds them. Non-owner schedules *do*
survive: they are canonical in `accounts.db`'s `AccountProgress` and are re-projected.

**Body** `{ confirm: 'REBUILD' }` — the exact token is required.
**Response** `200` — `{ ok: true, ... }`.
**Errors** `400` — confirm token missing or wrong.

---

## Diary `/api/diary`

A per-day study record at `{vault}/diary/`, a **sibling** of `workspace/` with its own git repo — so
it is invisible to the graph, search and file explorer for free. Summaries
(`summaries/summary-YYYY-MM-DD.json`) are derived idempotently from `ReviewLogs`; entries
(`entries/entry-YYYY-MM-DD.md`) are optional user prose. Per account, using the same unmarked-owner
shape as `OWNER_SCOPE`: the owner keeps the unprefixed layout, everyone else gets
`diary/accounts/<accountId>/`.

Surfaced as **"Logs"** in the UI. Only the label moved — the routes, the directory and the
`fb-diary-enabled` preference keep their names, because renaming them would be a migration that
silently reset everyone's opt-in.

**Roles:** Reader throughout. Opt-in is a *client* preference (`localStorage`); the server does not
gate on it and simply never creates `diary/` until a write endpoint is called.

**The MCP privacy gate.** The MCP server tags every request with `X-Flashback-Client: mcp`; the
React renderer sends no such header, so the in-app view is never affected. For a tagged request the
router consults `config.json`'s `mcpDiaryAccess` (Config → AI Assistant), read fresh from disk on
each request so the setting takes effect without a restart:

| `mcpDiaryAccess`        | Effect                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `none` (default)        | `403` on the whole namespace.                                       |
| `summaries`             | Summaries and the day list are readable; `/entry*` is `403`.        |
| `full`                  | Everything.                                                         |

Legacy booleans are honoured: `true` = `full`, `false` = `none`. This is real server-side
enforcement, not client-side self-censoring.

### `GET /api/diary`

Date-descending list of days that have a summary and/or an entry.

**Query** `from`, `to` — `YYYY-MM-DD`; anything malformed is ignored rather than refused.
**Response** `200` — the day list.

### `POST /api/diary/summary`

Regenerates the day's summary from `ReviewLogs` — cumulative and idempotent, so the client can call
it after every session. **Body** `{ date? }`, defaulting to today (UTC).

**Response** `200` — `{ ok: true, summary }`. `summary` is `null` when the day had no real reviews,
in which case nothing is written.
**Errors** `400` — `date` not `YYYY-MM-DD`.

### `POST /api/diary/rebuild`

Re-derives every summary from `ReviewLogs`. Idempotent.
**Response** `200` — `{ ok: true, count }`.

### `GET /api/diary/summary/:date`

**Response** `200` — the summary. **Errors** `400` bad date · `404` no summary for that date.

### `GET /api/diary/entry/:date`

**Response** `200` — `{ date, content }`; `content` is `''` when no entry exists (not a `404` — an
unwritten day is a normal state, not a missing resource).
**Errors** `400` bad date.

### `PUT /api/diary/entry/:date`

Saves the user's Markdown reflection. Lazy: empty content for a date with no existing entry is a
no-op rather than an empty file.

**Body** `{ content }`.
**Response** `200` — `{ ok: true, created, empty }`. **Errors** `400` bad date.

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

### `GET /api/seal/commit/:oid/files`

The paths one commit touched, for expanding a row in the history view.

| Param | In   | Type   | Required | Description                  |
| ----- | ---- | ------ | -------- | ---------------------------- |
| `oid` | path | string | Yes      | The commit's object id, from `GET /api/seal/log`. |

**Response** `200` — the commit's changed paths against its parent.

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

---

## Vault `/api/vault`

Identity and lifecycle of the vault this server is currently serving.

`GET /api/vault` is the **handshake**, and the reason it exists is symmetry: a Flashback Server answers exactly this shape, so a client that can talk to the local API can talk to a remote one without learning which it is. The desktop app *is* a Flashback Server serving one vault.

**On a server build (`config.singleVault`), `POST /switch` and `POST /release` are unmounted and answer `404`.** Not `403`: a client probing what a host can do should see a server that *cannot* switch vaults, rather than one that would if the caller had a better role. One vault per server is the model, and a switch closes the database and re-points every path resolver under every connected user at once. `GET /api/vault` and `GET /api/vault/list` are unaffected, so the handshake a remote depends on still works. See `docs/SERVER.md`.

### `GET /api/vault`

**Response** `200`

| Field                | Type     | Description                                                                    |
| -------------------- | -------- | ------------------------------------------------------------------------------ |
| `vaultId`            | string   | Stable UUID from `vault.json`; survives renames, moves and copies.             |
| `vaultName`          | string   | Current display name (the folder name).                                         |
| `appVersion`         | string   | Version of the Flashback build answering.                                       |
| `schemaVersion`      | number   | Highest applied migration — describes this **database**.                        |
| `canonicalVersion`   | number   | Highest applied canonical update — describes how far the vault's **files** have been brought forward. |
| `capabilities`       | string[] | Optional features this deployment offers, so a client can decide what to show without probing. |
| `update`             | object\|null | The headless server's release check: `{ current, latest, available, url, checkedAt }`. `null` on a desktop build, when the check is turned off, and before the first check has answered. |

The two versions are separate on purpose and are the compatibility contract: a client that understands neither should refuse to write rather than guess.

`capabilities` carries **server features, not roles** — the caller's own role is already on `GET /api/identity`, and repeating it here would put the same fact in two places. Three values are emitted today:

| Value | Meaning |
| --- | --- |
| `accounts` | `/api/accounts` is mounted, so a client may offer a people-management panel. Always present. |
| `requireAuth` | An anonymous caller is refused rather than treated as the Author. Set by a server build; absent on a desktop install. |
| `singleVault` | One vault per process: `POST /api/vault/switch` and `/release` are unmounted and answer `404`. |

The renderer uses these to decide whether to show its **Server** tab at all, which is why they describe the deployment rather than the person.

`update` is a **notice, never an instruction**. A headless server asks GitHub once at boot and once a day whether a newer published release exists (`FLASHBACK_UPDATE_CHECK=off` disables it and makes no outbound request at all), and reports what it last learned here. Nothing downloads, and nothing restarts: the process holds the only copy of the workspace and migrations are one-way, so when to upgrade is the operator's decision. `available` is false whenever the answer is not yet known, which is why it is safe to branch on directly. The desktop build reports `null` — it has electron-updater instead, and Config → About is where that surfaces.

---

### `GET /api/vault/list`

The registered local vaults and which one is active. Names and paths only — reporting counts would mean opening every other vault's database. Writes to this registry go through the Electron host, never here.

**Response** `200` — `{ activeVaultId, vaults: [{ id, name, isCustomPath, customPath, active }] }`.

---

### `POST /api/vault/switch`

Opens a different local vault **in this process**: quiesce Seal, close the database, move the config pointer, re-run validation/migrations/Seal init/canonical updates. Normally driven by the Electron host, which owns the registry; it is exposed over HTTP because only this process holds the database handle and Seal's pending-edit timer.

While a switch is in flight every other `/api/*` route answers `503 { error, switching: true }` with `Retry-After: 1`. `GET /` stays open and unaffected, so a client can poll for readiness.

| Field          | Type    | Required | Description                          |
| -------------- | ------- | -------- | ------------------------------------ |
| `name`         | string  | Yes      | Vault folder name.                   |
| `id`           | string  | No       | Registry id, recorded as `activeVaultId`. |
| `isCustomPath` | boolean | No       | Default `false`.                     |
| `customPath`   | string  | No       | Absolute parent directory when `isCustomPath`. |

**Response** `200` — `{ ok: true, vaultId, vaultName }`.

**Errors** `400` name required · `500` the vault could not be opened (the pointer is left where it was).

---

### `POST /api/vault/release`

Closes the active vault's database (checkpointing the WAL) and stops Seal's debounce timer, without opening another. Exists for renaming: Windows will not rename a directory holding an open file handle, and the WAL/SHM files beside the database are exactly that. There is no matching "resume" — the next database access re-opens lazily against whatever the config points at by then.

**Response** `200` — `{ ok: true }`.

---

## Remotes `/api/remotes`

### `GET /api/remotes`

The remote Flashback Server instances this install has registered. **Read-only, and credential-free by construction** — a remote's token never reaches this process at all. The Electron host holds it encrypted in the OS credential store and attaches it to requests itself, so the most this route can say about a credential is whether one exists.

That split is also why there is no write endpoint here: storing a token would mean writing it into `config.json`, in plain text, inside the user's vault directory, for a server that has nothing to do with this vault. Adding and removing remotes is an Electron IPC concern. The list is still served over HTTP because clients that are not the Electron renderer — the MCP server, a `dev:web` browser session — need to know which remotes exist.

**Response** `200` — `{ remotes: [{ id, label, url, hasToken }] }`.

---

## Identity `/api/identity`

### `GET /api/identity`

Who this server stamps new work as: the local, git-style user identity that goes into a new sidecar's `createdBy` and onto every Seal commit. Before it existed, both were stamped with the *vault name*, so renaming a vault changed the apparent author of all future work.

`source` says where the value came from — `vault` (this vault's override), `global` (the install-wide identity), or `default` (derived from the OS account, `<osuser>@flashback.local`, when nothing has been set). Resolution is override → global → default, and a `{name, email}` pair only counts when both halves are non-empty: a name with no address cannot produce an author line.

**Read-only**, for the same reason as `/api/remotes`: `user` is a `config.json` field the Electron main process owns, and a write route here would put two processes on one key. Editing goes through IPC. It is served over HTTP anyway so clients that are not the Electron renderer — the MCP server, a `dev:web` session — can say whose work they are looking at.

**This is not authentication.** Nothing validates the name or the address and nothing gates on either; a Flashback Server must treat an identity a client asserts as a claim, never as authorization. What authorizes a remote is its access token.

`account` is the other half of that sentence, and the two must not be confused. The top level is the **install's** self-asserted identity; `account` is **who the caller actually authenticated as**, resolved from their token, and it is the one that is real — it is what stamps their `createdBy` and their Seal commits. On a desktop install they are the same person. It is served here, rather than only on the admin-only `GET /api/accounts`, because every role deserves to be able to ask who it is.

**Response** `200` — `{ name, email, source: "vault"|"global"|"default", author: "Name <email>", account: { id, name, email, role } | null }`.

---

## Accounts `/api/accounts`

Who may reach this deployment, and as what. Admin for everything here except `POST /pure-token`, which is the Author's alone.

The store lives **outside every vault** so a copied vault carries no access list, and it is the only data in the app that cannot be rebuilt from the canonical files — back it up. A token's plaintext is returned exactly twice in this API's whole surface (issue and rotate) and is unrecoverable afterwards; only its hash is stored.

Three rules a ladder of roles cannot express are enforced here, where the actor and the target can be compared:

- **An admin may grant only Reader.** Admins run the vault; they do not decide who else runs it. This covers issuing tokens too — otherwise an admin could mint themselves an author token through the back door.
- **An admin may not revoke their own tokens**, and nobody may revoke the token they are authenticating with. An admin who locks themselves out has no recovery path; the pure token and the terminal both belong to the Author.
- **The Author cannot be demoted, deactivated or duplicated.** There is one owner, and rotation is the only way to change what proves you are them.

### `GET /api/accounts`
**Response** `200` — `{ accounts: [{ id, name, email, role, active, createdAt, tokens: [{ id, label, createdAt, lastUsedAt, revokedAt, active }] }], you }`. Never a hash, never a plaintext.

### `POST /api/accounts`
**Body** `{ name, email, role }` → `201` with the account.

Two refusals, and the status distinguishes them: a `role` that is **not a role** (missing, misspelled) is `400`, because the request is malformed; a role the caller **may not grant** is `403`, because that is a permission decision. Answering `403` to both told a client it lacked a permission when its payload was simply wrong.

### `PATCH /api/accounts/:id`
**Body** `{ role?, active? }` → `200` with the updated account.

### `POST /api/accounts/:id/tokens`
**Body** `{ label? }` → `201` `{ id, token, label, accountId, notice }`. **`token` is the plaintext and is shown once.**

### `DELETE /api/accounts/tokens/:tokenId`
→ `200` `{ ok: true }`. Idempotent; re-revoking keeps the original timestamp.

### `GET /api/accounts/:id/progress`
Admin. **Query** `?algorithm=` (optional) → `200` `{ account, scope, statistics }`. The study summary for **one other person** — the only endpoint in the API that reads a schedule that is not the caller's, which is why it lives under `accounts` (where the role guard already is) rather than under `srs` (where every route is deliberately about yourself).

`scope` is the account id, or the literal `'owner'` when the target is the Author — the sentinel from `requestContext.js`, surfaced so a caller can see which store the numbers came from. `statistics` is the same shape `GET /api/srs/statistics` returns. `404` for an account that does not exist.

### `POST /api/accounts/pure-token`
Author only. **Body** `{ label? }` → `201` `{ token, accountId, revoked, notice }`. Mints the token that proves ownership and revokes every previous Author token in the same transaction. If the store is unreachable or the token is lost, `npm run pure-token` does the same thing from the terminal against `accounts.db` directly — physical access to the file is the authorization, which is the same bargain every database makes.

---

## CORS

Not a route, but part of the HTTP contract. The policy is an **allowlist**, replacing the former `Access-Control-Allow-Origin: *`.

- **No `Origin` header → passes through, no ACAO set.** Node clients (the MCP server, the test suite, scripts) are not browsers; CORS has nothing to say about them and the API token is their gate.
- **Allowed origin → echoed**, with `Vary: Origin`.
- **Anything else → `403`.** The browser would block the response regardless; refusing outright also stops a non-preflighted "simple" cross-origin POST from executing unread, and turns a silent CORS failure into something greppable.

Allowed by default: `"null"` (the packaged renderer loads from `file://`), any loopback origin on any port, and every entry in `config.allowedOrigins[]` — the field a Flashback Server deployment sets to name its own web client.

`OPTIONS` preflights are answered with `204` **ahead of the auth guard**. A preflight is generated by the browser and cannot carry an `Authorization` header, so guarding it would 401 every browser client before its real request was ever sent. `Access-Control-Allow-Headers` covers `Authorization` and `X-Flashback-Client`.
