# Flashback Data Model

This document describes the data that Flashback keeps and where it lives. The code describes how the data moves.

## Stores

Flashback keeps data in four stores.

| Store | Location | Holds | Durability |
| --- | --- | --- | --- |
| Portable files | `{vault}/workspace/` | Documents, `.flashback` sidecars, decks, media and categories | Irreplaceable. Seal versions it. |
| Progress store | `{vault}/progress.db` | Schedules, review history, card health, FSRS weights, read positions and diary entries of each person | Irreplaceable. Not versioned. |
| Accounts store | `{baseDir}/accounts.db` | The accounts that can reach this install, and their roles | Irreplaceable. Not versioned. |
| Derived index | `{vault}/{vaultName}.db` | A queryable copy of the portable files | The Vault Doctor rebuilds it from the portable files. |

A backup needs the three irreplaceable stores. A rebuild reproduces only the derived index.

The stores fall into two roots. The portable root holds the portable files, which people can read without Flashback. It needs a filesystem with file locks, because Seal is a git repository. The data root holds the databases on a local disk, because SQLite needs local locks. `FLASHBACK_WORKSPACE_PATH` moves the portable root to its own mount.

Each database has its own schema version table. The derived index uses `SchemaVersion`. The progress store uses `ProgressSchemaVersion`. The accounts store uses `AccountsSchemaVersion`.

## Vault layout

A vault is a named directory. `config.json` lists the vaults in `vaults[]` and names the open one in `activeVaultId`.

```
{baseDir}/                  the app userData directory, or ./data in development
  config.json               server settings, vault and remote registries, user identity
  accounts.db               accounts store
  logs/
  {vaultName}/              a direct child of baseDir, or of the vault's custom path
    vault.json              vault identity
    workspace/              portable files, and the root of the Seal repository
      _decks/               deck files
      _categories.json      the categories
    {vaultName}.db          derived index
    progress.db             progress store
```

A vault is always a direct child of `baseDir` or of its custom path. There is no `vaults/` container. `RESERVED_NAMES` in `src/shared/vaultName.js` lists the names that a vault cannot take.

### vault.json

```json
{ "id": "<uuid>", "name": "dreams", "createdAt": "<iso>", "manifestVersion": 1 }
```

The `id` identifies the vault. It stays the same when you rename, move or copy the folder. Two copies of a vault have the same `id`. The `name` can change. `manifestVersion` versions this file only. The file sits outside `workspace/`, so Seal does not version it.

### config.json user identity

```json
{
  "user": {
    "name": "Daniel",
    "email": "daniel@example.com",
    "perVault": { "<vault-uuid>": { "name": "D. Pineda", "email": "d@acme.example" } }
  }
}
```

The identity of a vault comes from `user.perVault[activeVaultId]` first, then from `user`, then from the OS account. An entry counts only when both its name and its email are present. A new sidecar's `createdBy` and the Seal commit author both use this identity. On a served install, the caller's account supplies them. It is not authentication, and nothing grants access from it.

## Portable files

A file or a folder in `workspace/` can have a `.flashback` sidecar. A file's sidecar is `name.ext.flashback` beside the file. A folder's sidecar is `.flashback` inside the folder.

```
Inteligencia_Artificial/
  .flashback
  Clase060824.ipynb
  Clase060824.ipynb.flashback
  media/
  notes/
    .flashback
    breast_cancer_data.pdf
    breast_cancer_data.pdf.flashback
```

### Identity

Each sidecar and each card has a `globalHash`. A `globalHash` never changes. A copy gets new hashes and keeps the original hash in `copiedFrom`. Durable data, such as progress rows, deck entries and links, refers to a `globalHash`. It never refers to an index row id, because a rebuild assigns new row ids.

### Version and revision

Each portable file has a `formatVersion` integer. It names the format updates that the file has had. A file without it is version 0. The `FormatVersion` table records the updates that the whole vault completed. The file stamp is the authority. The table only lets a startup skip the walk.

A document has no stored revision number. Flashback computes its etag from the bytes of the body and of the sidecar.

| Update | Change | Older builds |
| --- | --- | --- |
| 1 | `type_answer` cards move the graded answer from `backText` to `answerText`. | An older build grades against the empty `backText`. |

### createdBy

A sidecar records its creator once, as a git author line `Name <email>`. Nothing rewrites it. Older sidecars can hold a vault name instead. Nothing checks or authorizes on this value.

### Folder sidecar

```json
{
  "formatVersion": 1,
  "globalHash": "unique-folder-hash",
  "tags": ["Artificial Intelligence", "Course", "Fall 2024"]
}
```

Every file and card below a folder inherits the folder's tags.

### File sidecar

```json
{
  "formatVersion": 1,
  "globalHash": "unique-file-hash",
  "createdBy": "Daniel <daniel@example.com>",
  "tags": ["Lecture", "KNN"],
  "excludedTags": ["AI"],
  "cover": { "kind": "pattern", "pattern": "arcs" },
  "highlights": [
    {
      "id": "h_3f9a1c0b2",
      "type": "text_offset",
      "color": "amber",
      "text": "K-Nearest Neighbors",
      "start": 412, "end": 433,
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "flashcards": [
    {
      "name": "optional descriptive name",
      "globalHash": "identifier",
      "tags": ["Definition", "Supervised Learning"],
      "category": "Concept",
      "cardType": "basic",
      "origin": "ai",
      "customData": { "html": "" },
      "vanillaData": {
        "frontText": "What is KNN?",
        "backText": "K-Nearest Neighbors algorithm",
        "media": { "front_img": "<sha256>", "back_img": "<sha256>", "front_sound": "<sha256>", "back_sound": "<sha256>" },
        "location": { "type": "highlight", "id": "h_3f9a1c0b2" }
      },
      "presence": 0.57,
      "level": 6, "easeFactor": 0.45, "lastRecall": "..."
    }
  ]
}
```

- `excludedTags` blocks the named inherited tags on this file.
- `color` is one of amber, green, blue and pink.
- `origin` is `ai` for a card that the MCP server created, and `import` for an Anki or Obsidian import. A handmade card has no `origin`.
- `presence` is a familiarity score that Flashback derives from the owner's schedule.
- `level`, `easeFactor`, `sm2Reps`, `lastRecall` and the `fsrs*` keys are a frozen schedule. They seed a card that has no progress row. Grading never writes them.
- The frozen schedule belongs to the owner. It seeds only the `owner` scope, and a reader's progress never comes from a sidecar.

### Highlights

A highlight exists without a card. A card points at a highlight through `location: { "type": "highlight", "id" }`. The position lives on the highlight.

| `type` | Document | Position |
| --- | --- | --- |
| `text_offset` | `.txt` | `start` and `end` character offsets. `text` re-anchors the highlight after an outside edit. |
| inline | Markdown | A `<mark data-color data-hl>` element in the body. No offsets. |
| `pdf_bbox` | PDF | `page` and `bbox {x, y, width, height}` in PDF units. |
| `clip_range` | Web clip | `start` and `end` offsets into the rendered text. |
| `video_timestamp` | YouTube | `start` and `end` in seconds. |

The `type` field is free text, so a new anchor type needs no migration.

### Card types

| `cardType` | Content |
| --- | --- |
| `basic` | `frontText` and `backText`, with optional media. |
| `reversible` | The same data as `basic`. A session shows it in either direction. |
| `cloze` | Text with `{{blank}}` markers. `frontText` and `backText` hold the same text. |
| `type_answer` | The question in `frontText`, the graded answer in `answerText`, and optional notes in `backText`. |
| `custom` | HTML in `customData.html`. The card does not use `vanillaData`. |

A `type_answer` card without `answerText` still keeps its graded answer in `backText`.

The media slots `front_img`, `back_img`, `front_sound` and `back_sound` hold a SHA-256 hash, not a path. The `Media` table maps the hash to a file.

### Tags and categories

Folders, files, cards and decks can have tags. A card has its own tags, plus the tags of its folders, its document and its decks.

A category is the teaching role of a card. Its priority sets the review order, lowest first. `DefaultData.js` seeds these categories:

| Priority | Categories |
| --- | --- |
| 0 | Definition, Terminology, Symbol |
| 1 | Concept, Example |
| 2 | Exercise, Procedure |

`workspace/_categories.json` holds every category as `{ "name", "priority", "description" }`. The `PedagogicalCategories` table mirrors the file, and the Vault Doctor restores the table from it.

### Media and covers

Each folder keeps its card media and cover images in its own `media/` directory. Card media stays in the folder when a document moves to another folder.

A document cover is `{ "kind": "pattern", "pattern" }` or `{ "kind": "image", "file", "y" }`. An image cover lives in the folder's `media/` as `cover-<hash>.<ext>`. The value `y`, from 0 to 1, is its vertical position. `src/shared/covers.js` defines the patterns and limits.

### Decks

A deck is a file `workspace/_decks/<globalHash>.json`. It lists cards by hash and never copies them. The `Decks` and `DeckEntries` tables mirror the file.

- `color` is one of slate, sage, ochre, brick, plum and ink. Without it, the deck's hash picks a color.
- `cover` has the same shape as a document cover. An image cover lives in `workspace/_decks/covers/`.
- `tags` pass to every member card.

One deck has `is_system: 1`. It holds every standalone card, which is a card without a source document. Its entry for a standalone card holds the card itself in `inline_card`. That snapshot is the only portable copy of the card. You cannot delete the system deck, and it always has the kraft color.

### Document links

A Markdown document links to another document with `[text](flashback://<globalHash>)`. The `DocumentLinks` table records each link by hash. A link can point at a document that does not exist yet.

## Seal

Seal is the git history of `workspace/`. It tracks documents, sidecars, media, decks and categories. It does not track the derived index, the progress store with its diary entries, `vault.json` or `config.json`.

A commit message has the form `<action>: <path>`. One user action makes one commit.

| Action | Cause |
| --- | --- |
| `create` | A new file, folder, import or deck |
| `edit` | A change to a file, sidecar, card, highlight, media or deck |
| `move` | A rename or a move, written `old/path -> new/path` |
| `delete` | A deleted file, folder or deck |
| `reconcile` | The Vault Doctor records changes made outside Flashback |

Grading a card writes no file and makes no commit. A rollback rewinds `workspace/` only. It does not change anyone's progress.

## Diary

The diary is an optional daily record of study. Its entries are personal data, so they live in the progress store and not in the shared portable files. Flashback derives its summaries.

- The `DiaryEntries` table holds one row for each account and day. The `content` column is Markdown.
- Only the writer reads an entry. The vault's author reads the daily summaries of other people, and no entry.
- A vault export puts the progress store in its own zip, apart from the portable files.
- Older builds kept the entries as files, in `{vault}/diary/` and then in `workspace/_diary/`. The first start of a newer build copies them into the table and keeps the files in `{vault}/diary.legacy`. It also deletes `_diary/` from the Seal history, so the ids of the commits that followed it change.
- The explorer, search, the graph and the documents API never reach `_diary/`, `_decks/`, `_categories.json` or `.git` in the workspace, under any spelling of the name.

### Summary

Flashback derives a summary from `ReviewLogs`. The `DiarySummaries` table in the derived index caches the summary of each past day. Flashback computes today's summary on every request.

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
  "struggledCards": [ { "globalHash": "...", "front": "...", "failCount": 2 } ],
  "streak": { "current": 12, "longest": 34 }
}
```

- A day is the user's local calendar day.
- `newCards` counts the cards whose first review falls on this date. `failed` counts reviews with `outcome = 0`.
- A review is a learning review while it is among the first `LEARNING_REVIEWS` reviews of its card. A phase without reviews has a null pass rate.
- `struggledCards` holds at most 10 cards, most failures first.
- A summary ignores reviews with a null `outcome`.

`mcpDiaryAccess` in `config.json` limits what the MCP server can read. `none` hides the diary. `summaries` shows the summaries only. `full` shows the summaries and the entries. An unknown value counts as `none`.

## Accounts store

`accounts.db` belongs to the install, not to a vault. A copied vault does not carry the access list. The Vault Doctor does not touch this store, and nothing can rebuild it.

| Table | Holds |
| --- | --- |
| `Accounts` | `id`, `name`, `email`, `role`, `created_at` and `active` |
| `AccountTokens` | The SHA-256 hash of each token, with its label, last use and revocation time |
| `AccountProgress`, `ReadProgress` | Old rows. Nothing reads them. Their data now lives in the progress store. |

The roles are reader, collaborator, admin and author, from lowest to highest. An install has exactly one author. The store keeps only the hash of a token, so you cannot recover a lost token. Revoking a token stops one device. Deactivating an account stops all its devices and keeps its progress.

A desktop install has one author account, made from the local identity. Its token is `apiToken` in `config.json`.

## Progress store

`progress.db` holds what each person did. Flashback attaches it to the derived index connection as the schema `progress`. It lives inside the vault, so it travels with a copied folder. It lives outside `workspace/`, so Seal does not version it. A Doctor rebuild does not touch it.

### Scope

Every row has an account scope. Every row except a `DiaryEntries` row also has the hash of a card or document. The scope is an account id, or the literal `owner` for the vault's author. The value `owner` is not an account id, because account ids do not travel with a copied vault.

No foreign key crosses from this store to the derived index. A card that leaves a sidecar keeps its progress rows. Only an explicit card delete deletes them. Deleting an account keeps its rows.

A missing `CardProgress` row means that the person never reviewed the card.

### Tables

| Table | Key | Holds |
| --- | --- | --- |
| `CardProgress` | `account_id`, `card_hash` | One person's schedule for one card |
| `ReviewLogs` | `id` | One row for each review |
| `FsrsParameters` | `account_id` | One person's fitted FSRS-6 weights |
| `ReadProgress` | `account_id`, `doc_hash` | How far one person read in one document |
| `DiaryEntries` | `account_id`, `date` | What one person wrote on one day |
| `CardHealth` | `account_id`, `card_hash` | The start of the window that card health analysis reads |
| `CardFlags` | `account_id`, `card_hash`, `kind` | Each raised card health flag |

### CardProgress

- `level` counts consecutive passed recalls, as a Leitner box.
- `sm2_reps` is the SM-2 repetition count.
- `fsrs_stability`, `fsrs_difficulty`, `fsrs_due`, `fsrs_state`, `fsrs_reps` and `fsrs_lapses` hold the FSRS-6 state. They stay null until a person grades the card under FSRS.
- There is no ease column. SM-2 reads its ease from the newest `ReviewLogs` row.

### ReviewLogs

- `outcome` is the grade. A null `outcome` marks a synthetic row that seeds the SM-2 ease from a sidecar.
- `algorithm` is `leitner`, `sm2` or `fsrs`. It tells the API and the MCP server which scheduler a vault uses.
- `session_id` and `session_position` place a review in one trainer session. A card shown twice takes two positions.
- `prev_distance` is the distance band, from 1 to 4, to the card shown before it. Band 1 means the same document, a shared tag or the same folder. Band 4 means nothing in common.
- `nearest_sibling_lag` counts the items since the nearest card in band 1.
- The session columns are null when no trainer session exists, as for the MCP server. Null means "not recorded".
- The table stores the grade only, never the typed answer.

### Gap bands

The gap of a card is the number of days between its reviews. `GAP_BANDS` in `src/shared/intervals.js` groups the gaps:

| Band | Gap |
| --- | --- |
| `new` | Never reviewed |
| `d1` | Up to 1 day |
| `wk` | Up to 7 days |
| `w3` | Up to 21 days |
| `m2` | Up to 60 days |
| `long` | More than 60 days |

A card with a gap of 21 days or more counts as held long-term.

### ReadProgress

A position is a unit and a locator.

| Format | `unit` | Locator |
| --- | --- | --- |
| `.pdf` | `page` | `{ page }` |
| `.epub` | `section` | `{ cfi, href, section }` |
| `.md`, `.txt`, `.clip` | `chars` | `{ offset }` |
| `.youtube` | `segment` | `{ seconds }` |

- `pos` is the current position. `far` is the furthest position.
- `total` comes from the writer. A position without `total` has no percentage.
- `body_etag` records the body revision that a `chars` offset belongs to.
- A document counts as finished when `far_pct` is 0.95 or more.
- The key is the document's `globalHash`, so a position stays with a renamed or moved document.

Positions never go into a sidecar.

### CardHealth and CardFlags

`CardHealth.epoch_at` starts the window of reviews that count as evidence. A null value means the whole history. `epoch_reason` is `edit`, `recovered` or `dismissed`. `content_fingerprint` is a hash of the card content at the last evaluation.

`CardFlags.kind` is `mouthful`, `probe`, `overdue_drift` or `session_fatigue`. `confidence` is `moderate` or `high`. `score` runs from 0 to 1. `evidence_json` holds the numbers behind the flag. A dismissed flag keeps its row and gets a `dismissed_at` time.

A flag stays until one of these events:

- A passed review at level 3 or more deletes the card's flags and sets `epoch_reason` to `recovered`.
- A content edit deletes all the card's flags for every account and sets `epoch_reason` to `edit`.
- A dismissal sets `dismissed_at` and moves the window start.

Flashback can recompute both tables from `ReviewLogs` and the card content.

## Derived index

`src/api/config/defaults/SchemaSQL.js` defines the tables, and the migrations in `src/api/config/migrations/` change them. Flashback derives every table from the portable files. Row ids change on each rebuild.

| Table | Holds |
| --- | --- |
| `Flashcards` | One row for each card. `document_id` is null for a standalone card. There are no schedule columns. |
| `FlashcardContent` | The text, HTML and media hashes of a card |
| `FlashcardReference` | Where a card points. A highlight reference has no position of its own. |
| `Highlights` | One row for each sidecar highlight |
| `Documents`, `Folders` | The workspace tree |
| `Decks`, `DeckEntries` | A copy of each deck file |
| `DocumentLinks` | Links between documents, by hash |
| `PedagogicalCategories` | The categories and their priorities |
| `Tags` | Tag names |
| `Nodes`, `NodeTypes`, `Connections`, `ConnectionTypes`, `InheritedTags` | The knowledge graph |
| `Media` | Media hashes and their files |
| `Subscriptions` | The last imported issue of each subscribed magazine |
| `FormatVersion` | The format updates that the vault finished |
| `DiarySummaries` | The cached daily summary of each account, for past days |
| `SchemaVersion` | The migrations that the index finished |

- `Flashcards.highlight_hash` copies the highlight id from the card's `location`. It can point at a deleted highlight.
- `FlashcardContent.answerText` holds the graded value of a `type_answer` card. It is null on other cards and on `type_answer` cards in the old shape.
- `Documents.global_hash` comes from the sidecar. The sidecar wins if they differ.
- `DeckEntries.inline_card` holds the snapshot of a standalone card. It is null for other cards.
- `relative_path` uses the separator of the platform, so compare it after replacing `\` with `/`. `absolute_path` is stale after a vault moves, until the Doctor syncs the index.
- The publisher owns the target folder of a subscription. Importing an issue deletes everything under it that the issue does not contain.

### Knowledge graph

Each card, document, folder, tag and deck has a row in `Nodes`. `Connections` joins two nodes with a type. The connection types are `connection`, `disconnection`, `inheritance`, `tag`, `reference`, `deck` and `link`. A `disconnection` cancels a connection between the same two nodes. `inheritance` and `reference` have a direction.

An inherited tag belongs to the connection that carries it. Deleting the connection deletes the tag.
