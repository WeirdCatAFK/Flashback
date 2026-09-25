# Flashback Data Model Specification

How Flashback's data is laid out and how each store behaves. This file describes the current
mechanism; history lives in git and `CHANGELOG.md`. How the access layer keeps the stores in sync
is `src/api/access/ACCESS.md`; the HTTP surface over them is `src/api/API.md`.

Four stores, three durability classes:

| Store | Where | Holds | Durability |
| ----- | ----- | ----- | ---------- |
| Canonical layer | `{vault}/workspace/` — documents + `.flashback` sidecars + `_decks/*.json` | documents, cards, highlights, tags, decks | Irreplaceable. Versioned by Seal. |
| Progress store | `{vault}/progress.db` | every person's schedule, review history, card health, FSRS weights, read positions | Irreplaceable. Not versioned. |
| Accounts store | `{baseDir}/accounts.db` | who may reach this install, and as what | Irreplaceable. Not versioned. |
| Derived index | `{vault}/{vaultName}.db` | normalized, queryable projection of the canonical layer | Rebuildable by the Vault Doctor. Holds nobody's history. |

`access/primitives/storage.js` reports disk usage per class (against `FLASHBACK_STORAGE_LIMIT`,
reporting only). A backup needs the three irreplaceable stores; the derived index is the one thing
a rebuild reproduces.

---

## Vault structure

All user data is scoped to a vault — a named, self-contained directory. `config.json` carries a
`vaults[]` registry and an `activeVaultId` pointer, plus the flat `vaultName`/`isCustomPath`/
`customPath` fields as the projection of whichever vault is active (every path consumer reads the
projection, so an older config still opens).

```
{baseDir}/                     ← app userData dir (USER_DATA_PATH), or ./data in standalone dev
  config.json                  ← server config + vault/remote registries + user identity
  accounts.db                  ← accounts, roles, token hashes (§ Accounts)
  logs/                        ← electron-log's rotating file, plus Chromium state dirs
  {vaultName}/                 ← vault root, a DIRECT child of baseDir (or of customPath)
    vault.json                 ← vault identity; not versioned by Seal
    workspace/                 ← canonical layer root; the Seal git repo root
    {vaultName}.db             ← derived index
    progress.db                ← progress store, ATTACHed to the index connection
    diary/                     ← per-day study record, its own git repo (§ Diary)
```

Path resolution (`access/primitives/config.js`) is a pure function of `config.json` and
`USER_DATA_PATH`, because the headless server, Docker and `dev:api` never run Electron main:

- `getVaultPath()` is `{customPath}/{vaultName}` when the registry entry carries a custom path, and
  `{baseDir}/{vaultName}` otherwise. There is no `vaults/` container and no fallback location.
- `USER_DATA_PATH` wins wherever it is set, Electron or not.
- `electron/vaults.js`'s `baseDirFor()` makes the same two-case choice for any registry entry, so
  main can inspect a vault it is not serving.

A default-location vault sits beside `config.json`, `accounts.db`, `logs/` and Chromium's state
directories, so `RESERVED_NAMES` (`src/shared/vaultName.js`) keeps a vault from being named after
one of them.

### Vault identity — `vault.json`

```json
{ "id": "<uuid>", "name": "dreams", "createdAt": "<iso>", "manifestVersion": 1 }
```

`id` is the only field anything should key on: it survives renaming, moving and copying the
folder, none of which the name survives. It sits outside `workspace/` so Seal never versions it and
`UpdateRunner`'s walk never sees it. `manifestVersion` tracks this file's own shape and is unrelated
to sidecar `formatVersion`. `ensureManifest()` is idempotent and runs on every vault open. A copied
vault keeps its id: two copies are the same vault as far as a future sync is concerned.

### Opening, switching and renaming

`src/api/vaultSession.js` owns the lifecycle. `openVault()` is the boot sequence — validate → Seal
init → canonical updates → ensure dirs — and runs identically at process start and on every
switch. `switchVault()` wraps it in a fixed order:

1. `sealEmitter.quiesce()` — drain Seal's commit queue, so no commit against vault A is in flight when B opens.
2. `closeDatabase()` — checkpoint the WAL so A is consistent and its files can be renamed.
3. Move the config pointer.
4. Re-open, and reset every vault-scoped cache through its `onVaultOpened()`.

Renaming is Electron-side (`electron/vaults.js`): release the database, move the folder and the
`{vaultName}.db` inside it, switch, then run the Doctor's `syncIndex` to repair `absolute_path` rows.

A **remote vault** is another Flashback Server exposing this same HTTP API. Switching to one
re-points the renderer's base URL and token; the local API keeps running, serving the local vault
to the MCP server. Which place the renderer points at is one piece of state in
`src/electron/connection.js`; its file header has the rules.

---

## Canonical layer

Every folder and file in `workspace/` may have a `.flashback` sidecar: `name.ext.flashback` beside a
file, `.flashback` inside a folder.

```
Inteligencia_Artificial
├── .flashback                        # folder-level metadata
├── Clase060824.ipynb
├── Clase060824.ipynb.flashback       # cards + metadata for this file
├── media/                            # this folder's card media and document covers
└── notes
    ├── .flashback
    ├── breast_cancer_data.pdf
    └── breast_cancer_data.pdf.flashback
```

`files.js` is the only module that reads or writes sidecars. Writes are atomic (tmp sibling +
rename), so a full disk mid-write leaves the previous sidecar intact.

### `formatVersion` — canonical file versioning

Every canonical file — folder sidecar, file sidecar, `_decks/*.json` — carries a `formatVersion`
integer naming which canonical updates it has been through. A file with none is version 0. The
stamp is per file because a file can arrive from anywhere (a backup, another machine, a Seal
rollback), so it must be self-describing: `config/UpdateRunner.js` reads the stamp, applies only
what that file still needs, and re-stamps. The `CanonicalVersion` table records what the vault has
finished, purely so a normal startup skips the walk. Full spec: `src/api/config/updates/UPDATES.md`.

### Content etag — revisions are computed, never stored

`formatVersion` says which *shape* a file is in, never which *revision*. A document's revision is
computed from the bytes on disk by `Files.etag()` and written nowhere, because a stored counter
goes wrong exactly when it matters: a Doctor rebuild, a Seal rollback, or an edit in another
program all change the file without incrementing it. The etag is `"<body>.<sidecar>"` — a document
is two files with two owners. Clients treat it as opaque; how writes are checked against it is
`src/api/API.md` § Concurrent writes.

### `createdBy`

A sidecar records who created it as a git author line, `Name <email>`, resolved from the local
user identity at creation. It is written once (`metadata.createdBy || …`) and never rewritten, which
is what makes it provenance. Readers must tolerate three shapes: a vault name (files created before
identities existed; deliberately not backfilled), `Name <email>`, and whatever a Flashback Server
stamped. Nothing parses it and nothing authorizes on it — it is self-asserted text.

### Local user identity — `config.json` `user`

```jsonc
{
  "user": {
    "name":  "Daniel",
    "email": "daniel@example.com",
    "perVault": { "<vault-uuid>": { "name": "D. Pineda", "email": "d@acme.example" } }
  }
}
```

Resolution (`config.getIdentity()`, `getAuthorString()`) is `user.perVault[activeVaultId]` → `user`
→ derived from the OS account (`<osuser>@flashback.local`). A pair counts only when both halves are
non-empty, so a half-filled entry falls through rather than yielding `Daniel <>`. There is always an
answer. It feeds exactly two consumers, kept identical so a file and the commit that created it
agree: a new sidecar's `createdBy` and the Seal commit author.

The override lives under `user`, keyed by vault id: it is a fact about the person and must not
travel with a copied vault. The setup wizard asks once; skipping writes no `user` key, so `source`
reports `default`. This is not authentication — nothing validates or gates on it. Electron main is
its only writer; `GET /api/identity` is read-only.

### Folder sidecar

```json
{
  "formatVersion": 1,
  "globalHash": "unique-folder-hash",
  "tags": ["Artificial Intelligence", "Course", "Fall 2024"]
}
```

Folder tags are inherited by every file and card below it.

### File sidecar

```jsonc
{
  "formatVersion": 1,
  "globalHash": "unique-file-hash",
  "tags": ["Lecture", "KNN"],
  "excludedTags": ["AI"],
  "cover": { "kind": "pattern", "pattern": "arcs" },   // optional, see Documents table
  "highlights": [
    {
      "id": "h_3f9a1c0b2",            // stable per-document id
      "type": "text_offset",           // anchor strategy, see below
      "color": "amber",                // amber | green | blue | pink → --color-hl-* tokens
      "text": "K-Nearest Neighbors",   // snapshot, used for list views and re-anchoring
      "start": 412, "end": 433,        // position, meaning depends on type
      "createdAt": "…", "updatedAt": "…",
      "cardHashes": [],                // optional mirror; not reliably populated
      "refIds": []                     // reserved
    }
  ],
  "flashcards": [
    {
      "name": "optional descriptive name",
      "globalHash": "identifier",
      "tags": ["Definition", "Supervised Learning"],
      "category": "Concept",
      "cardType": "basic",
      "origin": "ai",                  // present + 'ai' = created via MCP; absent = handmade
      "customData": { "html": "" },
      "vanillaData": {
        "frontText": "What is KNN?",
        "backText": "K-Nearest Neighbors algorithm",
        "media": { "front_img": "sha256", "back_img": "sha256", "front_sound": "sha256", "back_sound": "sha256" },
        "location": { "type": "highlight", "id": "h_3f9a1c0b2" }
      },
      "presence": 0.57,
      "level": 6, "easeFactor": 0.45, "lastRecall": "…"   // frozen SRS snapshot, see below
    }
  ]
}
```

**The SRS fields on a sidecar card are a frozen snapshot.** `level`, `easeFactor`, `sm2Reps`,
`lastRecall` and the six `fsrs*` keys are read once, to seed a card that has no progress row (a
vault can arrive as `workspace/` with no `progress.db`), and ignored once one exists. Nothing writes
them. Grading writes no file and makes no Seal commit, for anyone. They stay in the file so an older
build still finds what it expects.

### Highlight anchoring

A highlight exists independently of any card; a card anchors to one with
`location: { type: "highlight", id }`, and the geometry lives on the highlight, not the card.

| `type` | Producer | Position encoding |
| ------ | -------- | ----------------- |
| `text_offset` | `.txt` (default) | `start`/`end` char offsets; `text` snapshot re-anchors after out-of-band edits |
| *(inline)* | Markdown | `<mark data-color data-hl>` in the body; no offsets; survives surrounding edits |
| `pdf_bbox` | `PdfRenderer` | `page` + `bbox {x,y,width,height}` in PDF units (scale 1) |
| `clip_range` | `ClipRenderer` | `start`/`end` offsets into rendered `textContent`, `text` fallback |
| `video_timestamp` | `YoutubeRenderer` | `start`/`end` in seconds |

`type` is free text, so a new strategy needs no migration. A Markdown registry entry with no inline
mark (the MCP server's `create_highlight` writes only the sidecar) is re-anchored on load by
searching the rendered text for its snapshot, and becomes an inline mark on the next save.

Card `location` forms besides `highlight` — `text_offset`, `pdf_location`, `video_timestamp` with a
`data` object — are still accepted by `FlashcardReference` but no UI emits them.

---

## Flashcard types

`cardType` drives both the renderer and the form. Stored as `Flashcards.card_type`, default `basic`.

| `cardType` | Behaviour |
| ---------- | --------- |
| `basic` | Two-sided flip; front and back are independent text + media. |
| `reversible` | Basic data; direction is randomised per session so the card tests both ways. |
| `cloze` | Text with `{{blank}}` markers. Front shows gaps; back reveals them in amber. `frontText` and `backText` hold the same text. |
| `type_answer` | Question in `frontText`, expected answer in `answerText`, optional post-review notes in `backText`. The Trainer compares the typed value to `answerText` only (case-insensitive, trimmed). |
| `custom` | Full HTML in `customData.html`, rendered in a sandboxed `<iframe srcdoc>` with no network. `vanillaData` is unused. |

```jsonc
// type_answer
{ "cardType": "type_answer",
  "vanillaData": { "frontText": "What is the capital of France?", "answerText": "Paris",
                   "backText": "On the Seine; capital since 987.", "media": { … } },
  "customData": { "html": "" } }

// custom
{ "cardType": "custom",
  "vanillaData": { "frontText": "", "backText": "", "media": {} },
  "customData": { "html": "<div style='font-size:24px'>Custom content</div>" } }
```

**Media slots** (`front_img`, `back_img`, `front_sound`, `back_sound`) hold a SHA-256 hash, never a
path; `GET /api/media?hash=` resolves it through the `Media` table. All non-custom types support
all four.

**Reading rules for older shapes.** Both shapes exist on disk, because a Seal rollback can restore
an old sidecar at any time:

- No `cardType` → `card.cardType ?? (card.isCustom ? 'custom' : 'basic')`.
- `type_answer` with no `answerText` keeps its graded answer in `backText`. The compared value is
  `answerText`, falling back to `backText` when absent or empty; notes exist only when `answerText`
  does. Implemented once per side: `typeAnswerParts()` (`src/ui/components/flashcard/flashcardFields.js`)
  and `answerBody()` (`access/orchestration/cardHealth.js`). Canonical update 001 plus migration 008
  move vaults to the new shape; the fallback stays regardless. A build older than the split cannot
  read the new shape — see `UPDATES.md` § One-way updates.

---

## Tags and categories

- **Tags** apply at folder, file, card and deck level and propagate downward through `InheritedTags`,
  so a card carries the union of its document chain's tags and every deck it belongs to. A card's
  `excludedTags` blocks named inherited tags.
- **Categories** are a card's pedagogical role and set review priority (lower = first). Defaults,
  seeded by `DefaultData.js` and editable on the Metadata screen:

| Priority | Categories |
| -------- | ---------- |
| 0 | `Definition`, `Terminology`, `Symbol` |
| 1 | `Concept`, `Example` |
| 2 | `Exercise`, `Procedure` |

## Media

Each folder keeps its own `media/` directory for its cards' media and its documents' cover images,
so a folder is self-contained for packaging and sharing. Markdown documents may reference files in
it, rendered only through Flashback's frontend. Card media does not follow a document moved to
another folder.

---

## Seal — workspace versioning

`src/api/seal/seal.js`. A git history of the canonical layer (documents, sidecars, media, decks)
using isomorphic-git, so no system git is required. The repo root is `workspace/`; the index, the
progress store, `vault.json` and `config.json` are outside it and never tracked.

- **`SealEventEmitter`** — no database knowledge. One way in, one serial queue out: `edit()`,
  `create()`, `move()` and `delete()` enqueue a commit and resolve once it has landed, so request
  order is commit order and no timer outlives its request. Every commit shares the queue because a
  commit snapshots the whole index and two at once would race over HEAD. `flushEdits()` drains the
  queue; structural operations call it first. `quiesce()` drains it before a vault switch.
- **`SealTools`** — `init()`, `log()`, `inspect()`, `rollback()`, `commitDrift()`. Imports nothing
  from the access layer.

### Commit format

`<action>: <path>`. Folder operations stage every contained file and sidecar in one commit, so each
commit is one user action.

| Action | Trigger |
| ------ | ------- |
| `create: path/file.md.flashback` | `createFile`, `createFolder`, `importFile`; deck creation (`_decks/<uuid>.json`) |
| `edit: path/file.md.flashback` | `updateFile`, `updateMetadata`, `addMediaToFlashcard`, highlight and card patches, media changes, deck edits |
| `move: old/path -> new/path` | `rename`, `move` |
| `delete: path/file.md.flashback` | `delete`; deck deletion |
| `reconcile: <path \| N files>` | `SealTools.commitDrift()` — the Vault Doctor sealing out-of-band changes |

Grading a card is not in this table: it writes no file.

### Rollback

`rollback(ref)` rewinds the workspace and nothing else. Schedules live in `progress.db`, which git
does not track, so a checkout cannot move anyone's study progress. Afterwards the derived index must
be reconciled with the Vault Doctor's `syncIndex()`, which walks the disk directly: right after a
rollback HEAD equals the working tree, so `inspect()` reports no drift even though the index has
diverged, and the reconciling sync makes no `reconcile:` commit.

### Out-of-band change detection

`inspect()` diffs HEAD against the working tree (`git.statusMatrix`) and returns
`{ added, modified, deleted }` sidecar paths. It feeds the Seal view's "Loose pages" panel and is
supplementary context for the Doctor, which reconciles each category (index / reindex / remove from
index). `commitDrift()` is its inverse: it stages every out-of-band change, deletions and
non-sidecar files included, into one `reconcile:` commit so a later rollback treats it as history.

---

## Diary — study record

An opt-in, per-day record of study activity (`access/orchestration/diary.js`, `/api/diary`). It is
metadata about studying, not study material, so it sits outside the knowledge graph.

```
{vault}/diary/                               ← its own git repo, a sibling of workspace/
  summaries/summary-YYYY-MM-DD.json          ← the owner's, machine-derived, read-only in the UI
  entries/entry-YYYY-MM-DD.md                ← the owner's optional prose
  accounts/<accountId>/{summaries,entries}/  ← everyone else, same shape
```

- **Per account.** The owner keeps the unprefixed layout (the same unmarked-owner shape as
  `OWNER_SCOPE`), so a vault written before accounts reads back unchanged.
- **One repo, several people's prose.** On a shared vault an admin can read it, which is why the UI
  names it "Logs" on a remote and shows a privacy note (`src/ui/diaryLabels.js`); locally it is a
  "Diary". Only the label moves — routes, directory and preference keep the name `diary`.
- **Invisible for free.** The file walker, search and graph only descend inside `workspace/`, so
  diary files never appear there and cannot carry cards, with no exclusion code.
- **Its own git repo**, initialised lazily on first write so an opted-out vault stays clean. Commits
  use `<action>: <path>` with actions `summary` and `entry`. Writes are atomic (tmp + rename).

A summary and an entry are independent files joined by date; either can exist alone. There is one
cumulative summary per date.

### Summary schema (v2)

Summaries are derived from `ReviewLogs` and fully regenerable. `generateSummary` is idempotent and
cumulative: regenerating a date reproduces the same file modulo `generatedAt`, which powers
`POST /api/diary/rebuild`. The Diary view re-derives today every time it opens; the file is
rewritten and committed only when its content changed. The Trainer's session-end summary waits for
the session's last review to save.

The day boundary is the user's local calendar day (`date(timestamp, 'localtime')`), because the API
runs on the user's machine. Every day-keyed reader — diary aggregates, the Stats heatmap and streak,
the client's "today" — must use the same boundary.

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

- `newCards` counts cards whose earliest-ever review falls on this date; `failed` counts
  `outcome = 0`; `passRate = (reviews - failed) / reviews` over all reviews.
- A review is *learning* while it is among its card's first `LEARNING_REVIEWS` (`srs.js`) reviews
  ever, *review* afterwards — the same split the Stats view uses. `reviewPassRate` is the day's
  retention figure. Either phase's rate is `null` when that phase had no reviews. A v1 summary lacks
  the phase fields; rebuilding backfills them.
- `byDeck` counts a card once per deck it is in; `byDocument` covers anchored cards only;
  `struggledCards` is capped at 10, most-failed first (`front` is `(custom card)` for custom cards).
- `streak` is computed as of the summary's date, so regeneration stays idempotent.
- Rows with `outcome IS NULL` (synthetic logs) are excluded from every aggregate.
- There is no time-spent or session-count field: `ReviewLogs` records no per-review duration.

### AI-assistant privacy gate

`config.json` `mcpDiaryAccess` (default `none`, set in Config → AI Assistant) limits what the MCP
server may read: `none` closes the diary, `summaries` exposes summaries and the day list but not the
`/entry` routes, `full` opens everything. A legacy boolean reads `true` → `full`, `false` → `none`.
The MCP client tags every request `X-Flashback-Client: mcp` and `routes/diary.js` answers `403`
per the level. The value is read fresh from disk (`config.getMcpDiaryAccess`, fail-closed: an
unrecognized value is `none`), so a change applies without a restart. The renderer sends no such
header and is never gated. The read tools are `diary_list`, `diary_get_summary` and
`diary_get_entry` (the last needs `full`).

---

## Accounts — who may reach this install

`{baseDir}/accounts.db`, created and repaired by `access/primitives/accounts.js` itself (never by
`MigrationRunner`, whose version counter belongs to the vault index). It holds identity and access
only.

```
Accounts(id, name, email, role, created_at, active)
AccountTokens(id, account_id → Accounts.id, token_hash, label, created_at, last_used_at, revoked_at)
AccountsSchemaVersion(version, applied_at)       -- this store's REPAIRS
AccountProgress(…), ReadProgress(…)              -- fossils: unread; their rows were copied to progress.db
```

It sits outside every vault because roles are a fact about this deployment: an access list that
travelled with a copied vault would hand the copy's new owner the original readers' access. So:

- **The Vault Doctor never touches it.** There is no canonical form of an account to rebuild from.
- **Nothing reconstructs it.** It is a backup obligation, alongside the workspace and `progress.db`.
  On a server the volume holds `config.json`, `accounts.db` and the vault; a vault backup alone does
  not contain the access list (`docs/SERVER.md`).
- **A vault switch does not re-open it.** Accounts belong to the install.

`role` is `reader` < `collaborator` < `admin` < `author` (`src/shared/roles.js`), a strict ladder.
Exactly one Author exists; several Admins may. Revoking one token leaves that person's other
devices working; deactivating the account stops all of them and keeps their progress.

### Tokens

Only `sha256(token)` is stored; the plaintext is returned once at issue and is unrecoverable
afterwards — rotate instead. Lookup is by hash of the presented token, so no constant-time
comparison exists in the auth path. `last_used_at` is written at most once per token per minute.

The pure token is the Author's. Issuing one revokes every previous Author token in the same
transaction. `npm run pure-token` does the same against the file directly, for a deployment whose
API is stopped or refusing everyone — physical access to `accounts.db` is the authorization.

### On a desktop install

`Api.start()` provisions one Author from the local identity and adopts `config.apiToken` as its
token (re-enabling it if a rotation had revoked it), so every request resolves to that Author and
the desktop app behaves as if accounts did not exist. A served deployment has no `apiToken` in its
config, so the step does nothing there.

---

## The progress store — `{vault}/progress.db`

Behavioural data: what each person did. `access/primitives/progress.js` owns its schema and
repairs (`ProgressSchemaVersion`). `database.js` ATTACHes it to the index connection as the schema
`progress`, so a schedule joins against `Flashcards` in one statement and a review's writes share
one queue and one transaction with the caller.

It lives inside the vault (travels with a copied folder) but outside `workspace/` (a review is not
an edit, so Seal never versions it). Tables: `CardProgress`, `ReviewLogs`, `CardHealth`, `CardFlags`,
`FsrsParameters`, `ReadProgress` — all keyed by account scope plus a canonical hash (`card_hash` or
`doc_hash`), never by an index row id, because a Doctor rebuild reassigns row ids and only the hash
survives it.

Rules SQL cannot state for you:

- **Every statement is schema-qualified** (`progress.CardProgress`). An unqualified `CREATE TABLE`
  lands in `main`, and an empty table there silently shadows the real one for every unqualified
  read.
- **No foreign key crosses the schema boundary** (one declared anyway is accepted at `CREATE` and
  fails on every insert). Nothing cascades. A card that disappears from a sidecar — rollback, partial
  write, out-of-band edit — leaves its rows. Only an explicit delete purges, through
  `query.purgeCardBehaviour(cardHash)`, called from `documents._deleteFlashcardLocked` and the deck
  delete in `decks.js`; sidecar reconciliation must not purge. Deleting an account leaves its rows.
- **Attaching buys serialization and joins, not crash atomicity.** WAL commits each attached file
  separately; a review is not atomic across the two files.
- **A Doctor rebuild does not touch it.** `query.wipeDerivedContent()` names only index tables, so
  a rebuild costs nobody their schedules, history, card-health verdicts or fitted weights.

### Per-user progress and the owner scope

A card's schedule is a property of a person. Everything derived from a review is keyed by an
account scope: an account id, or the literal `'owner'` (`OWNER_SCOPE` in `src/api/requestContext.js`)
for the vault's Author.

`'owner'` is deliberately not the Author's account id: account ids live in `accounts.db`, which does
not travel with a copied vault, so a stamped uuid would orphan every owner row on copy. The sentinel
means "whoever owns these files here".

The scope is resolved once, at each orchestrator's entry (`srs.js`, `cardHealth.js`, `diary.js`,
`sequencer.js`, `decks.js`, via `currentScope()`), and passed down explicitly. `query.js` refuses a
missing scope rather than defaulting to the owner, which would silently hand the owner's schedule
to whoever forgot the argument. Call sites that name `OWNER_SCOPE` outright are the places where the
data belongs to the files rather than the caller: reconciling against a sidecar
(`_syncDocumentFlashcards`, the Doctor's drift check), writing a canonical file (`_decks/*.json`
snapshots, an Anki import's carried-over schedule), and `Documents.presence`.

`presence` is the one owner/non-owner asymmetry: it is derived from the owner's levels and stored on
the document, so `documents.submitReview`/`undoReview` skip `propagatePresence` for other scopes.

A missing `CardProgress` row means "never reviewed by this person". Every reader COALESCEs, so a row
appears on first review rather than at card creation.

### Read progress

Where a person has read to in a document, captured automatically as they read and overridable by
hand (`access/orchestration/readProgress.js`, `/api/progress`). Stored in `progress.ReadProgress`
for everyone, the owner included, and never in the sidecar: a position moves continuously, so a
sidecar home would turn reading into a commit stream, and a Reader cannot write a sidecar at all
(`PUT /api/documents/metadata` is collaborator-gated). Recording a position writes no file and makes
no commit. Nothing is projected into the index, so a rebuild neither restores nor damages it.

**Identity.** Keyed by the document's canonical `globalHash` read from the sidecar, not
`Documents.global_hash` (derived, and able to disagree with the sidecar). When a write finds them
disagreeing it corrects the index toward the sidecar. Keying by hash means a position survives a
rename or move and does not follow a `copy`, which regenerates identities. Rows whose account was
deleted are filtered on read, never deleted.

**Units.** A position is a `unit` plus a locator, in the vocabulary `mcpReader` paginates by, so a
stored position can bound a text read:

| Format | `unit` | Locator | Addresses the reader with |
| ------ | ------ | ------- | ------------------------- |
| `.pdf` | `page` | `{ page }` | `index` |
| `.epub` | `section` | `{ cfi, href, section }` | `index` = `href` |
| `.md` `.txt` `.clip` | `chars` | `{ offset }` | `offset` |
| `.youtube` | `segment` | `{ seconds }` | `at` |

- EPUB: `mcpReader`'s section numbers count readable sections only (it skips textless spine items),
  so they are not spine indices. `href` bridges the two: the CFI resumes the renderer, the href
  addresses the reader, and neither ordinal is converted into the other.
- `chars` is a scroll fraction (no text renderer keeps a character offset), and the reader offset is
  derived from the percentage — a bound, not a cursor. `body_etag` records what it was measured
  against; when the body changes, the percentage is kept and the absolute offset dropped.
- `total` is always supplied by the writer, never computed server-side (that would make a folder
  listing extract every PDF in it). A position without one is a valid resume point with no
  percentage.
- For `page`, `chars` and `segment`, `_percentOf` derives `locator / total` when the writer sends no
  percentage. For `section` it derives nothing: the renderer's percentage is the only prose-weighted
  scale, and the renderer withholds it until epub.js's `locations` index is built, re-publishing
  once it lands.

**Current, furthest, finished.** `pos` is where you are, `far` the furthest you have reached. An
`auto` write always moves `pos` and advances `far` only forward; a `manual` write sets both and may
move `far` backwards. Finished is derived, `far_pct >= 0.95` (`FINISHED_PCT`), because real documents
end in back matter nobody reads; "mark as finished" writes 1.0. A missing row means never started
and is never backfilled.

**Studying what you have read.** `GET /api/srs/due?read=only` holds back cards from unread material.
`readProgress.studyFilter()` returns two plain lists that `routes/srs.js` hands to the scheduler,
because `srs.js` may not import an orchestrator that reaches the filesystem. The lists are
deliberately asymmetric — the filter hides only what it can prove you have not reached:

- A document never opened is absent from the allow list, holding back its whole pile.
- A card is held back only when its anchor provably sits past `far`. Unresolvable positions stay in
  the session: an EPUB CFI, a Markdown inline highlight, a card with no anchor. Standalone cards are
  never gated. A finished document short-circuits before its sidecar is read.

Nothing is rescheduled; a held-back card reappears when the flag comes off. A card's position is
read from the sidecar by joining `flashcards[].location.id → highlights[].id`
(`readProgress._cardPositions()`), because the indexed `FlashcardReference` row for a highlight
anchor carries no geometry and `highlights[].cardHashes` is not reliably populated.

**Rollups.** A folder rollup counts documents in its subtree as `finished`, `inProgress` (a position
exists, not finished) and `unread`. `percent` averages every document, unread counting as 0. A
document with no denominator counts as `inProgress`, never `finished`, and stays in the total. A
subscription rollup is a folder rollup over the subscription's `target_path`, labelled with the
magazine.

---

## Session sequencing — presentation order

Two decisions, kept apart and composed only at the route layer (`routes/srs.js` `GET /due`):

- **Selection** — which cards are due. The scheduler (`srs.js`, `query.getDueFlashcards`), from due
  dates alone.
- **Sequencing** — the order they are shown in. `sequencer.js` + the pure `sequencing.js`.

Sequencing never moves a card across days; pulling a card forward or deferring one would corrupt
the retention estimates.

Order is interleaved rather than blocked: cards authored together from one context, reviewed
back-to-back, build fluency bound to that shared cue, which the next day's shuffled recall does not
supply. So graph proximity is a spacing signal — confusable cards still share a session, where
discrimination is learned, but separated by unrelated material.

### Approximate distance

`query.getSessionFacets()` reads each card's document, folder ancestry, tags (direct + inherited),
decks and linked documents in a fixed number of statements; `distance()` derives a band:

| d | Relationship |
| - | ------------ |
| 1 | same document, shared tag, or same immediate folder — confusable |
| 2 | shared deck, or their documents are directly linked |
| 3 | documents share an ancestor folder within two levels |
| 4 | nothing in common |

### Constraints

- Hard: two cards at d ≤ 1 are separated by at least `MIN_LAG` (4) items.
- Soft: prefer `TARGET_DISTANCE` (3), not the maximum — always jumping as far as possible makes every
  transition the same kind of jump.
- Soft: a weak card (new, or level ≤ 2) may take a same-cluster run of up to `WEAK_RUN_MAX` (3), so
  the pattern is extracted before discrimination under load. Per card, outgrown as strength rises.
- Pedagogical tiers are an outer partition: sequencing happens within a tier.

### Degradation ladder

Reported as `relaxation` on the `/due` response. Failure degrades toward randomness, never toward
clusters.

| Rung | Trigger |
| ---- | ------- |
| `none` | the full lag held |
| `no-folder-edge` | > 40% of pairs read as confusable; the same-folder edge is dropped first |
| `short-lag` | the tier cannot sustain `MIN_LAG`; the lag drops to what fits |
| `shuffle` | not even adjacent placement fits; plain seeded shuffle |

`short-lag` is computed: spacing *k* cluster-mates *g* apart in *n* slots needs `(k-1)(g+1)+1 ≤ n`.
Ordering is seeded (`mulberry32`), so a session is reproducible and `tests/sequencing.test.js` pins
exact sequences.

---

## Data dictionary — derived index (`{vaultName}.db`)

Built by `src/api/config/defaults/SchemaSQL.js` (`SchemaVersion` is created by `MigrationRunner`);
changed through migrations (`src/api/config/migrations/MIGRATIONS.md`). Every
table here is re-derivable from the canonical layer. The flashcard is the atomic unit; `Nodes` and
`Connections` form the knowledge graph over flashcards, documents, folders, tags and decks, and a
`DELETE` trigger on each typed table removes its `Nodes` row.

### Flashcards

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | Row id. Reassigned by a Doctor rebuild — never key durable data on it. |
| global_hash | varchar(500) | The card's canonical, immutable identity. |
| node_id | integer (FK) | Graph node. |
| document_id | integer (FK) | Source document (ON DELETE CASCADE). NULL for a standalone card. |
| category_id | integer (FK) | Pedagogical category. |
| content_id | integer (FK) | → `FlashcardContent`. |
| reference_id | integer (FK) | → `FlashcardReference`. |
| name | varchar(500) | Optional descriptive name. |
| origin | varchar(500) | `'ai'` = created via the MCP server; NULL = handmade. Set once. Mirrors the sidecar's `origin`. |
| presence | float | Owner-derived familiarity metric, mirrored into the canonical layer. |
| fileIndex | integer | Position within the source file. |
| card_type | text | `basic` / `reversible` / `cloze` / `type_answer` / `custom`. Default `basic`. |

There are no schedule columns: a schedule belongs to a person and lives in `progress.CardProgress`.

A standalone card (`document_id = NULL`) lives in the index plus an entry in the system deck's
JSON, whose `inline_card` snapshot is its only canonical copy.

### FlashcardContent

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| custom_html | text | User HTML (`custom` cards). |
| render_html | text | Processed HTML for display. |
| frontText | varchar(500) | Front text. |
| backText | varchar(500) | Back text. On `type_answer`, post-review notes — never compared. |
| answerText | varchar(500) | `type_answer` only: the graded value. NULL elsewhere, and on a pre-split `type_answer` card (answer still in `backText`). |
| front_img, back_img, front_sound, back_sound | varchar(500) | Media hashes. |

### FlashcardReference

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| type | varchar(500) | `highlight` (current), or a legacy direct form. |
| start, end | float | Offsets (time, character, …). NULL for `highlight`. |
| page | integer | PDF page. |
| bbox | json | Bounding box. |

A `highlight` reference is `(type='highlight', NULL, NULL, NULL, NULL)`; the geometry is on the highlight.

### Highlights

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| document_id | integer (FK) | Owning document (ON DELETE CASCADE). |
| global_hash | varchar(500) | Unique; the id a card's `location` points at. |
| type | varchar(50) | Anchor strategy (§ Highlight anchoring). Default `text_offset`. |
| start, end | float | Position, meaning depends on `type`. |
| page | integer | PDF page. |
| bbox | json | PDF bounding box. |
| color | varchar(20) | Swatch key, default `amber`. |
| note | text | Optional note. |
| created_at | timestamp | |

Synced from the sidecar's `highlights[]` on every save (`highlights.syncFromSidecar`), never by a
card insert. Several cards may anchor to one highlight.

### Documents

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| folder_id | integer (FK) | Parent folder (ON DELETE CASCADE). |
| node_id | integer (FK) | Graph node. |
| global_hash | varchar(500) | Derived from the sidecar; the sidecar wins on disagreement. |
| relative_path, absolute_path | varchar(500) | Paths. `absolute_path` is repaired by `syncIndex` after a vault rename. |
| name | varchar(500) | Display name. |
| origin | varchar(500) | Source identifier (e.g. subscription `magazine_id`). |
| encoding | varchar(20) | Detected character encoding. |
| presence | float | Owner-derived familiarity, stored on the document. |

**Covers.** A sidecar may carry `cover`: `{ kind: 'pattern', pattern }` (drawn by the renderer, no
file) or `{ kind: 'image', file, y }` with the image in the folder's `media/` (`cover-<random>.<ext>`,
registered in `Media`) and `y` (0..1) its vertical position in the banner. Optional, no
`formatVersion` bump; shapes and limits are shared with deck covers in `src/shared/covers.js`. Only
the cover routes change it: a whole-sidecar write keeps the cover on disk, because renderers save
highlights by writing back the sidecar they loaded.

### Folders

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| global_hash | varchar(500) | From the folder sidecar. |
| node_id | integer (FK) | Graph node. |
| parent_id | integer (FK) | Parent (ON DELETE CASCADE); NULL = workspace root. |
| relative_path, absolute_path | varchar(500) | Paths. |
| name | varchar(500) | |
| origin | varchar(500) | Source identifier. |
| presence | float | Familiarity score. |

### Decks

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| node_id | integer (FK) | Graph node. |
| global_hash | varchar(500) | Unique; also the canonical file name `_decks/<global_hash>.json`. |
| name | varchar(500) | |
| description | text | |
| is_system | integer | `1` for the one reserved deck holding every standalone card. Cannot be deleted. |
| created_at, updated_at | timestamp | |

A deck is a named collection of card references (by hash; cards are linked, never copied). The
canonical copy is `workspace/_decks/<uuid>.json`; this table and `DeckEntries` mirror it. Each write
goes to the file first and the rows second, under `pathLock` on the deck file (see ACCESS.md for the
rollback race the lock closes). `_decks/` is filtered out of the file explorer and the Doctor's
document walk.

Fields that live only in the deck file (no column, no migration, nothing for a rebuild to lose):

- **`color`** — one of `slate`, `sage`, `ochre`, `brick`, `plum`, `ink` (`src/shared/deckColors.js`).
  Absent → the colour its hash picks; a new deck gets the first colour no deck shows yet. The system
  deck is always kraft and refuses a colour.
- **`cover`** — `{ kind: 'pattern', pattern }` (`cards` | `arcs`) or `{ kind: 'image', file, y }` with
  the image in `workspace/_decks/covers/` (`<deckHash>-<random>.<ext>`, new name per upload), so Seal
  versions it and a copied vault carries it. Replacing or removing a cover, or deleting the deck,
  deletes the old image in the same commit. A `file` failing the strict name pattern reads as no cover.
- **`tags`** — also written as direct tags on the deck's node. They flow to member cards as
  inherited tags on the deck→card `Connections` row (type `deck`), revoked through `InheritedTags`'
  cascade when the card leaves or the deck is retagged or deleted. A deck has no parent, so its own
  tags are direct only.

A standalone card's own tags live in the system deck's entry snapshot (`entries[].card.tags`,
omitted when empty) and are derived as direct `tag` connections on the card's node, where every tag
filter already looks.

### DeckEntries

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| deck_id | integer (FK) | Owning deck (ON DELETE CASCADE). |
| card_hash | varchar(500) | The referenced card's `global_hash`. |
| document_path | varchar(500) | Source document path, denormalized for display. |
| position | integer | Insertion order, default 0. |
| inline_card | text | Standalone cards only: JSON snapshot of the card, written alongside the system-deck entry. The Doctor's `rebuildIndex()` restores standalone cards from it. NULL for anchored cards. |

### DocumentLinks

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| source_hash | varchar(500) | Document containing the link. |
| target_hash | varchar(500) | Linked document. |
| anchor_text | varchar(500) | Link text at last sync. |

A hash-keyed queue with no foreign keys, so a link to a not-yet-imported document is recorded now
and resolved once the target exists. `(source_hash, target_hash)` is unique. Filled by
`documents.syncDocumentLinks()` from `[text](flashback://hash)` links in saved Markdown; the Graph
view draws them as `link` edges.

### PedagogicalCategories

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| name | varchar(500) | Category name. |
| priority | integer | Review order, lower first. |
| description | text | |

### Tags

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| name | varchar(500) | Tag label. |
| node_id | integer (FK) | Graph node (ON DELETE CASCADE). |
| origin | varchar(500) | Source identifier. |
| presence | float | Familiarity score. |

### Nodes, NodeTypes, Connections, ConnectionTypes, InheritedTags

| Table | Columns |
| ----- | ------- |
| Nodes | `id`, `type_id` → NodeTypes |
| NodeTypes | `id`, `name` (flashcard, document, folder, tag, deck) |
| Connections | `id`, `origin_id` → Nodes, `destiny_id` → Nodes (both ON DELETE CASCADE), `type_id` → ConnectionTypes |
| ConnectionTypes | `id`, `name`, `is_directed` |
| InheritedTags | `id`, `connection_id` → Connections, `tag_id` → Tags (both ON DELETE CASCADE) |

Connection types in use: `connection`, `disconnection` (an explicit override suppressing a same-pair
`connection`), `inheritance`, `tag`, `reference`, `deck`, `link`. `inheritance` and `reference` are
directed. An inherited tag is stored on the connection that carries it, so removing the connection
revokes the tag.

### Media

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| hash | varchar(500) | SHA-256, the value card media slots store. |
| name | varchar(500) | |
| relative_path, absolute_path | varchar(500) | Location on disk. |

### Subscriptions

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| magazine_id | varchar(500) | Subscription source; one row per magazine. |
| issue_id | varchar(500) | Last imported issue. |
| version | varchar(100) | Its version string. |
| target_path | varchar(500) | Workspace path the content is installed at. |
| last_sync | timestamp | Last successful import. |

Updated by `subscriptions.importIssue()`. Not account-scoped. No UI triggers it; it is reachable only
through the API.

### CanonicalVersion

| Column | Type | Description |
| ------ | ---- | ----------- |
| version | integer (PK) | Update version, matching `config/updates/NNN_*.js`. |
| applied_at | timestamp | When the pass completed. |
| description | text | The update's one-line summary. |

Written by `UpdateRunner` only after a pass with nothing skipped. An optimisation, not the source of
truth — that is each file's `formatVersion` — so losing it costs one redundant walk.

---

## Data dictionary — progress store (`progress.db`, schema `progress`)

Every table is keyed by an account scope (an account id or `'owner'`, no foreign key — it points
into another file) plus a canonical hash (no foreign key — keys cannot cross the schema boundary).

### CardProgress

One person's schedule for one card. `PRIMARY KEY (account_id, card_hash)`, `WITHOUT ROWID`; the
scope leads because every query pins it.

| Column | Type | Description |
| ------ | ---- | ----------- |
| account_id | text | Scope; default `'owner'`. |
| card_hash | text | The card's `globalHash`. |
| level | integer | Consecutive positive recalls (Leitner box). |
| sm2_reps | integer | SM-2 repetition count, separate from `level`. Default 0. |
| last_recall | timestamp | Last recall by this person. |
| fsrs_stability | float | FSRS-6 stability in days. NULL until rated under FSRS. |
| fsrs_difficulty | float | FSRS-6 difficulty. |
| fsrs_due | timestamp | Next due under FSRS (other schedulers derive theirs from `last_recall` + interval). |
| fsrs_state | integer | 0 = new. |
| fsrs_reps | integer | Default 0. |
| fsrs_lapses | integer | Default 0. |

There is no `ease_factor` column: SM-2's ease is read from the newest `ReviewLogs` row.

### ReviewLogs

| Column | Type | Description |
| ------ | ---- | ----------- |
| id | integer (PK) | |
| card_hash | text | The card's `globalHash`. |
| account_id | varchar(64) | Whose review; NOT NULL, default `'owner'`, indexed. |
| timestamp | timestamp | When the review happened. |
| outcome | integer | Recall result. NULL marks a synthetic row — the SM-2 ease seed `query.seedEaseFromSidecar()` writes when a card is seeded from its sidecar snapshot — excluded from every aggregate. |
| ease_factor | float | SM-2 ease. |
| level | integer | Level after the review. |
| algorithm | varchar(20) | `leitner` / `sm2` / `fsrs` — which scheduler graded it. NULL = not recorded. |
| session_id | varchar(64) | Groups one trainer session's reviews. Indexed. |
| session_position | integer | 0-based position in the session, counting what was actually shown (a re-queued card takes two). |
| prev_distance | integer | Distance band (1–4) to the card shown immediately before. |
| nearest_sibling_lag | integer | Items since the nearest confusable sibling appeared in the session. |

- `algorithm` is how the API and MCP server learn which scheduler a vault is on
  (`srs.detectAlgorithm()`), since the active algorithm is a browser preference.
- The four session columns record how a card was *presented*, written by `routes/srs.js` from
  `sequencer.measureOrdering()`. Interleaving deliberately lowers within-session accuracy; these
  columns let that dip be told apart from a regression. They are NULL for callers with no session
  (the MCP server, scripts, the Flashcards view), and NULL means "not recorded", never distance 0.
- Only the grade is stored, never a typed answer. That bounds card-health analysis to grades,
  timestamps, FSRS state and card structure.

### FsrsParameters

One person's fitted FSRS-6 weights, written by `POST /api/srs/optimize`. `PRIMARY KEY (account_id)`,
`WITHOUT ROWID`.

| Column | Type | Description |
| ------ | ---- | ----------- |
| account_id | text | Scope. |
| weights_json | text | The 21 weights; absent → `fsrs.js` defaults. |
| optimized_at | timestamp | Last fit. |
| review_count | integer | Rated reviews the fit used. |

Per account because the weights model one person's forgetting curve; for the same reason
`/optimize` is reader-level.

### ReadProgress

| Column | Type | Description |
| ------ | ---- | ----------- |
| account_id | text | Scope. |
| doc_hash | text | The document's canonical `globalHash`. |
| unit | text | `page` / `section` / `chars` / `segment`. |
| total | real | Writer-supplied denominator, or NULL. |
| pos, far | text | JSON locators: current and furthest. |
| pos_pct, far_pct | real | Percentages, or NULL. |
| body_etag | text | Body revision a `chars` offset was measured against. |
| updated_at | text | |

`PRIMARY KEY (account_id, doc_hash)`, `WITHOUT ROWID`. Semantics in § Read progress.

### CardHealth

The analysis watermark, one row per evaluated card per account. A flag is a live judgement: once a
card is *addressed*, analysis restarts from that moment. Per account because the evidence is one
person's interval trajectory.

| Column | Type | Description |
| ------ | ---- | ----------- |
| account_id | text (PK) | Scope. |
| card_hash | text (PK) | The card's `globalHash`. |
| epoch_at | timestamp | Analysis window start; reviews at or before it are not evidence. NULL = whole history. |
| epoch_reason | varchar(20) | `edit`, `recovered`, `dismissed`. |
| content_fingerprint | varchar(64) | Hash of front + back + answer + custom HTML + type at last evaluation. |
| updated_at | timestamp | |

`content_fingerprint` detects an edit arriving through any path (the PUT route, the MCP server, a
rollback, a Doctor reindex): `cardHealth.buildContext()` resets the epoch on a mismatch, lazily and
per account. `cardHealth.onCardEdited()` is the one cross-account operation — it clears every
account's flags on the card at once, because the flags describe text that no longer exists.

### CardFlags

One row per currently raised flag, per person. `PRIMARY KEY (account_id, card_hash, kind)`, so
re-raising refreshes in place.

| Column | Type | Description |
| ------ | ---- | ----------- |
| account_id | varchar(64) | Scope. |
| card_hash | text | The card's `globalHash`. |
| kind | varchar(40) | `mouthful`, `probe`, `overdue_drift`, `session_fatigue`. |
| confidence | varchar(20) | `moderate` or `high`. |
| score | float | Detector strength, 0–1. |
| evidence_json | text | The numbers behind the verdict. |
| level_at_detection | integer | Card level when raised. |
| detected_at | timestamp | Last raised or refreshed. |
| review_log_id | integer | The failing review that raised it. Not an FK — reviews can be undone. |
| dismissed_at | timestamp | Set when the user rules on it; suppressed, not deleted. |

`evidence_json` — peak intervals across relearn cycles, FSRS difficulty slope, answer token count
against the vault median, overdue ratios, lapse count, window age, and `memoryModel` (`fsrs` or
`approximated`) — makes a flag arguable rather than an oracle; the UI renders it.

### Card health lifecycle

Classification runs only when a card has just failed; criticising a card that is working is the
failure mode the design avoids.

| Trigger | Effect |
| ------- | ------ |
| Failing review (`outcome = 0`, or FSRS `rating = 1`) | Classify over the epoch window; upsert flags. A dismissed row refreshes but stays suppressed. |
| Passing review reaching level ≥ 3 | Recovery: delete live flags, `epoch_reason = 'recovered'`. |
| Passing review below level 3 | Nothing — a mouthful passes constantly at a one-day interval. |
| Content edit | Delete all flags, dismissed included; `epoch_reason = 'edit'`. |
| Dismiss | Set `dismissed_at` on that kind; move the watermark. |
| Undo review | Re-classify against the shortened ledger. |

Both tables are recomputable from `ReviewLogs` plus card content, absent from sidecars and never
sealed. They survive a Doctor rebuild with the rest of the progress store. Detector semantics and
the mouthful/probe discriminator: `src/api/access/ACCESS.md` § `cardHealth.js`.
