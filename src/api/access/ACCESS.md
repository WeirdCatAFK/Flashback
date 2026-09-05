# Flashback Access Layer

The Access layer is the core of the Flashback system, responsible for maintaining synchronization between the canonical (filesystem) and derived (SQLite) data layers.

**CRITICAL**: All data modifications must go through these modules. Never write directly to `.flashback` sidecars, and never call `db.prepare()` against the **vault database** outside of `query.js` (the accounts store and the `.apkg` reader are separate databases with their own handles — see Import rules). For the data model, see [DATAMODEL.md](../../../DATAMODEL.md).

---

## Tier Structure

Modules are organized in three strict tiers, and **each tier is a folder on disk**. A module may only import from tiers below it — which means a relative specifier that climbs into a *higher* tier's folder is a violation you can see in the import line itself.

```
access/
  orchestration/   Tier 3   documents · subscriptions · media · srs · decks · highlights
                            doctor · diary · mcpReader · cardHealth · sequencer
                            ankiImport · obsidianImport   (package import, built on the rest of Tier 3)
                            fsrs · ankiPackage · sequencing (pure helpers — no DB, no IO into the vault)
  resources/       Tier 2   query · files · pathLock, safeFetch, cardRemovalBudget (pure — no DB, no IO)
  primitives/      Tier 1   config · database · accounts · vault
                            sqliteAdapter (the async driver both stores are built on)
```

Imports within a tier stay relative (`./query.js` from `files.js`); imports downward name the tier (`../primitives/database.js` from `resources/query.js`). Nothing outside `access/` may reach past a tier folder, so callers write `access/orchestration/documents.js`, never `access/documents.js`.

`fsrs.js`, `ankiPackage.js` and `sequencing.js` live in `orchestration/` next to their only consumers (`srs.js`/`cardHealth.js`, `ankiImport.js` and `sequencer.js` respectively) even though they are pure functions that import nothing — they are engine parts of a Tier 3 module, not a tier of their own.

Filenames on disk are lowercase (`query.js`, `files.js`, `config.js`, `database.js`, `documents.js`, `srs.js`, `subscriptions.js`, `media.js`, `decks.js`, `highlights.js`, `doctor.js`, `diary.js`, `mcpReader.js`, `ankiImport.js`, `obsidianImport.js`) — module *class* names inside them are capitalized (e.g. `class Documents`, `class Decks`), which is the source of the mixed casing seen in imports elsewhere in the codebase.

**Import rules:**
- **Spaced-repetition reads and writes take an explicit `scope`.** An account id, or the literal `'owner'` for the vault's Author (`requestContext.js` `OWNER_SCOPE`). Resolve it **once** at the orchestrator's entry point with `currentScope()` — `srs.js`, `cardHealth.js`, `diary.js`, `sequencer.js` and `decks.js` all do — and pass it down. `query.js` never reads it ambiently and **throws on a missing one** rather than defaulting: whose data a statement returns is not something a call site should have to go somewhere else to find out, and a default would answer that question wrongly in silence. A handful of sites name `OWNER_SCOPE` outright and each says why in a comment — reconciling against a sidecar, writing a canonical file, or Seal's rollback snapshot. See `DATAMODEL.md` § Per-user progress.
- `query.js` and `files.js` never import each other.
- **`srs.js` never imports `documents.js`.** The reverse is not true and is not meant to be: `documents.js` imports `srs.js` and holds it as `this.srs`, because `submitReview`/`undoReview` are document operations — they grade a card that lives in a sidecar, and the sidecar write and the schedule write have to happen in one server operation. The dependency runs one way only, which is the property that matters: the scheduler knows nothing about files, so it stays testable without a workspace and a rebuild can re-derive schedules without replaying document history.
- `documents.js` may be imported by other Tier 3 modules that need to create/update real workspace files as part of a larger operation — currently `subscriptions.js` (issue merge), `obsidianImport.js` (vault import creates one document per note), and `doctor.js` (re-indexes documents from disk). The rule is "any orchestrator that needs real files", not a fixed list.
- `doctor.js` is read-only toward the canonical layer: it re-derives the SQLite index from the on-disk files and sidecars but never writes document content or regenerates a `globalHash`. It imports `documents.js`, `decks.js`, `files.js`, `query.js`, and Seal.
- `mcpReader.js` imports `files.js` and nothing else — it is a read-only reader, so it needs neither the index nor an orchestrator.
- **Canonical updates do not live in this tier.** Versioned rewrites of the sidecars and `_decks/*.json` are `config/UpdateRunner.js` + `config/updates/`, the document-driven counterpart of `config/migrations/` — see `config/updates/UPDATES.md`. The runner imports *downward* into this layer (`files.js`, `query.js`, `decks.js`) exactly as `routes/` does; nothing in `access/` imports it back, apart from `files.js` and `decks.js` reading `LATEST_VERSION` from the dependency-free `config/updates/registry.js` to stamp new files.
- `cardHealth.js` imports `query.js` and the pure `fsrs.js` helpers only — never `srs.js`, never `documents.js`. It is composed at the route layer (`routes/srs.js`, `routes/flashcards.js`) the same way `/detail` already composes `decks` + `srs`, which keeps the scheduler ignorant of the classifier.
- `sequencer.js` follows the same rule for the same reason: it imports `query.js` and the pure `sequencing.js` engine only, and `routes/srs.js` composes `SRS.getDue()` → `sequencer.sequence()`. Selection (which cards are due) and sequencing (what order they're shown in) must stay separable, because topology is never allowed to move a card across days.
- `ankiImport.js` does **not** import `documents.js` — Anki cards have no source document (they land in decks/standalone cards only), so it talks to `files.js`, `query.js`, and `decks.js` directly instead.
- `ankiPackage.js` imports nothing from `access/` at all. It only parses the `.apkg` container into plain objects, so `ankiImport.js` is the only module that knows a package became cards, and `ankiPackage.js` is the only one that knows about zstd, protobuf, or which schema generation the collection uses.
- Raw `db.prepare()` calls outside `query.js` are not allowed **against the vault database**, with one narrow exception: `decks.js` runs a `PRAGMA table_info(Decks)` directly (schema introspection to detect whether the system-deck migration has run yet), not a data query.
- The rule is scoped to that one store, and two other modules hold their own handles on purpose. `accounts.js` writes its own SQL against **`accounts.db`**, which is a different database with no `query.js` of its own — five tables it creates itself, never seen by `MigrationRunner`, and deliberately unreachable from the vault's statement layer so that nothing scoping itself to a vault can accidentally read the install's access list. `ankiImport.js`/`ankiPackage.js` hold a **synchronous better-sqlite3** handle because an `.apkg` *is* a SQLite database — someone else's, read-only, outside the adapter entirely.

---

## Tier 1 — Primitives

### `config.js`
Config reader/writer. `USER_DATA_PATH` locates `config.json` wherever it is set — Electron or plain Node; only with the variable absent does it fall back to `<cwd>/data`. Exposes:
- `get()` — returns the config object (cached after first read; creates default if missing).
- `getVaultPath()` / `getWorkspacePath()` / `getDatabasePath()` — canonical resolvers. All three are **pure per-call functions over `get()`**, which is what makes switching vaults a matter of moving one pointer.
- `reload()` — drops the cache. Needed because `config.json` has two writers (this process and Electron main).
- `setActiveVault(entry)` — moves the pointer: writes `activeVaultId` *and* the flat `vaultName`/`isCustomPath`/`customPath` projection together, merged into a fresh disk read. Only `vaultSession.js` should call it; closing the old database and re-validating are that module's job, not this one's.
- `getVaults()` / `getActiveVaultId()` / `getRemotes()` / `getAllowedOrigins()` — registry readers. `getVaults()` synthesizes a single entry from the flat fields when `vaults[]` is absent, so callers never special-case an un-migrated config. `getRemotes()` is credential-free by construction.
- `getIdentity()` / `getAuthorString()` — the local user identity, git-style. `getIdentity()` returns `{name, email, source}` resolving `user.perVault[activeVaultId]` → `user` → derived from the OS account; `getAuthorString()` renders it as `Name <email>`, which is both a sidecar's `createdBy` and a git author line, deliberately the same string. A `{name, email}` pair only counts when **both** halves are non-empty. Reads through the cached `get()`, so `reload()` on a vault switch is what makes the override per-vault — there is no separate cache to invalidate. Consumed by `files.js` (Tier 2) and `seal.js` (outside the tiers); writes belong to Electron main, which owns the `user` key.
- `set(config)` — writes and caches a whole config object.

### `sqliteAdapter.js`
`createSqliteAdapter({ resolvePath, onOpen })` → `{ db, openDatabase, closeDatabase, isOpen }`. The async data layer, as a factory, because there are now **two** stores behind the same contract: the vault database and the accounts store. A Postgres driver has to satisfy this same interface for both.

`db` is an **explicit surface** — `prepare` / `exec` / `pragma` / `transaction` / `close` / `inTransaction` / `raw` — not a Proxy forwarding whatever better-sqlite3 exposes, because that surface *is* the contract a second driver implements. `prepare()` stays **synchronous** and returns a statement whose `.get`/`.all`/`.run` are async; that is what kept the port of `query.js`'s 221 statements to `await` rather than a rewrite of every call form.

**A transaction takes an exclusive lock against all access to its own store.** On one connection an `await` inside a transaction is a yield, so a statement from another request would otherwise join the open `BEGIN` and vanish with it on rollback — no error, just a row that was written and is gone. Nesting maps to `SAVEPOINT`s. `tests/dbAdapter.test.js` pins this; the interleaving case there fails against a naive promisified wrapper.

**The queue and the `AsyncLocalStorage` are per instance, and that is load-bearing.** A shared context would make a statement on store B, issued inside a transaction on store A, believe it already held B's lock and skip B's queue; a shared queue would deadlock outright the first time a write to B happened inside a transaction on A. Postgres must not inherit the lock at all — it has real MVCC, so a transaction there checks out a dedicated client.

### `database.js`
One instance of the adapter over `config.getDatabasePath()` — the **vault** database, derived and rebuildable from the canonical files. WAL and foreign keys always on. Re-exports `openDatabase()` / `closeDatabase()` (the latter checkpoints the WAL) / `isOpen()`.

The default export must keep a fixed identity: nine modules import it and `query.js` stores the reference in a constructor that runs once at import, so an ESM binding could never be re-pointed — the swap has to happen behind an object whose identity never changes.

This is only safe because **no prepared statement outlives a request**: every `prepare()` in `query.js` is a local `const` used immediately. Never hoist `db.prepare(...)` or `db.transaction(...)` into a module-level constant.

### `accounts.js`
The **accounts store** — who may reach this API and as what. The other instance of the adapter, at **`{baseDir}/accounts.db`**, a sibling of `config.json` and outside every vault. Imports `config.js` and the adapter factory only.

Outside the vault deliberately: a vault folder is meant to be copied and handed to someone else, and an access list that travelled with it would grant strangers whatever the original readers had. Two consequences follow — the **Vault Doctor must never touch it** (there is no canonical form of an account, so a rebuild would delete every token in the deployment), and it is **the one store in the app that cannot be reconstructed**, which makes it a backup obligation. It is also *not* re-opened on a vault switch; accounts belong to the install.

Tables `Accounts` / `AccountTokens` / `AccountsSchemaVersion`, created by the module itself on first open and never seen by `MigrationRunner` (that runner is the vault database's; one version counter must not mean two things).

It also holds two per-person tables that must not travel with a copied vault: `AccountProgress` (every **non-owner's** SRS schedule) and `ReadProgress` (**everyone's** reading position, the owner's included — see `readProgress.js`). Both are keyed by `vault_id` plus a `globalHash`, never a row id, because a Doctor rebuild reassigns every row id in the vault database and only the hash survives it.

Only a SHA-256 hash of a token is stored; the plaintext is returned once at issue and is unrecoverable afterwards. `resolveToken()` therefore looks up by hash of the caller's input, which is why no constant-time comparison appears anywhere.
- `ensureLocalAuthor(apiToken)` — idempotent provisioning, called from `Api.start()`. Creates the single Author from `config.getIdentity()` if absent, then adopts this install's `apiToken` as that Author's token. The adoption is what makes roles invisible on a desktop install.
- `resolveToken()` / `hasUsableToken()` / `listAccounts()` / `getAccount()` / `getAuthorAccount()` / `getToken()`
- `createAccount()` / `updateAccount()` / `issueToken()` / `revokeToken()` / `rotatePureToken()`
- `saveAccountProgress()` / `getAccountProgress()` / `listAccountProgress()` / `deleteAccountProgress()` — never called for the owner; their canonical copy is the sidecar.
- `saveReadProgress()` / `getReadProgress()` / `listReadProgress()` / `deleteReadProgress()` — **is** called for the owner. Read progress has no second canonical home to drift from. `scope` carries an account id or `OWNER_SCOPE` and so has no foreign key to `Accounts`; rows whose account was deleted are filtered on read, never deleted.

### `vault.js`
Vault identity. `vault.json` at the vault root — a stable UUID that outlives renames, moves and copies, since the database can be rebuilt and `vaultName` is just a folder name. Deliberately a **sibling of `workspace/`**, not inside it: identity is not something to version or roll back, so Seal never tracks it and `UpdateRunner`'s walk never sees it (hence no `formatVersion`). Imports `config` only.
- `readManifest()` / `ensureManifest()` / `getVaultId()` — `ensureManifest()` is idempotent, which is how vaults predating it acquire an id on their next launch instead of needing a migration.
- `inspectVaultDir(dir)` — does an arbitrary directory hold a vault? Tests for `workspace/` + a `*.db`; a manifest is **not** required, or an older vault could never be adopted.

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
- **Text vs. binary.** `readFile()` returns `{ content, encoding, binary, size }`. A file is binary if its extension is a known container format (`.pdf`, `.epub`, `.zip`, …) **or** the first 8 KB contain a NUL byte (unless chardet says UTF-16/32, which is legitimately NUL-heavy). The extension check matters on its own: an uncompressed PDF can be pure ASCII, and "decoding" it yields PDF syntax rather than prose. Binary files are **never decoded** — `content` is `null`, `encoding` is `"binary"` — and their bytes are served by `GET /api/documents/raw`, their *text* by [`mcpReader`](#mcpreaderjs). `isBinaryFile()` exposes the same test; `updateFile()` uses it to refuse a *string* write over a binary file (a `Buffer` write — a real re-import — still passes), because document bodies are not versioned by Seal and the overwrite would be unrecoverable. Callers that only handle prose (`documents._extractLinks`, `documents.searchContent`, `highlights` context) can therefore treat a null `content` as "skip" instead of each re-deriving the file-type rule.
- `readBuffer()` / `statFile()` — raw bytes and size+mtime, for callers that parse a container format themselves (`mcpReader`) or key a cache on file version. They go through `safePath` like everything else, which is why those callers never touch `fs`.
- `updateFile()` with `content == null` is a **metadata-only** write: the body is left untouched and the sidecar's recorded encoding is preserved.
- `globalHash` generation on file/folder creation (immutable after first assignment).
- `etag(relPath)` — the document's **version**, for detecting a write that lost a race. Two sha256 digests joined by a dot, `"<body>.<sidecar>"`, because a document is two files with two different owners: an editor replaces the body wholesale while merging the sidecar from a fresh read, and a PDF renderer writes only the sidecar. `documents._assertFresh` compares the half the write replaces, so a card added through the Inspector never fails an editor's save. The body half exists only for `EDITABLE_BODY_EXTENSIONS` (`.md`/`.markdown`/`.txt`/`.text`) — every other format's body is read-only, so its bytes cannot go stale under an editor, and hashing a 50 MB PDF per read would buy nothing. Derived on demand, **stored nowhere**: a counter has to be bumped by whoever writes, so it would report "unchanged" after a Doctor rebuild, a Seal rollback, or an edit made in another program.
- `entityEtag(entity)` — the same idea for one card or highlight *inside* a sidecar, with keys sorted before hashing so the digest describes the value rather than a writer's key order. This is what lets a patch conflict only with a patch to the same entity.
- `walkWorkspace()` — read-only, pre-order recursive walk returning `{folders, documents, mediaDirs, strayItems}`. Each folder/document entry carries `{relPath, meta, sidecarExists, sidecarCorrupt}`; `strayItems` are files with no sidecar (`kind: 'untracked-file'`) or sidecars with no owning file (`kind: 'orphan-sidecar'`). Skips `.git`, root-level `_decks`, and `media/` dirs (recorded in `mediaDirs`, not descended). Used by the Vault Doctor to compare disk against the index.

### `safeFetch.js`
The one door out to the open web. Pure — node builtins only, no config and no IO — so
`tests/safeFetch.test.js` runs with no vault and no SQLite binary, like `pathLock.js`.

Everything this app fetches on a user's behalf is a URL *they* supplied: the page a clip
captures, a picture inside that page. A plain `fetch` on such a URL is a request issued from
wherever the process runs, which is not where the address came from — on a server that is the
deployment's private network, cloud instance metadata (`169.254.169.254`) included, and a clip
stores the answer as a document the caller can read back. On the desktop it is the user's own
LAN, reachable by anything driving the MCP server.

- `assertFetchableUrl(url, { allowPrivate })` — http(s) only, and never an address that
  resolves into a loopback, private, link-local, CGNAT or multicast range (v4, v6, and v4
  addresses wearing a v6 hat). Refusals carry `status: 400`, so the API answers "your address"
  rather than "our fault".
- `safeFetch(url, init, opts)` — the same signature as `fetch`, with **every redirect hop**
  re-checked: a public host is free to answer `302 Location: http://169.254.169.254/`, and a
  guard that only checked the URL it was handed would wave that through. Forces
  `redirect: "manual"` for that reason.

`allowPrivate` comes from `config.allowPrivateNetworkFetch` (default off) and exists for the
install that genuinely means to clip from its own intranet. It lifts the address check and
nothing else — the scheme restriction stands either way.

**Known limit, deliberately stated:** the lookup here and the one the fetch performs are two
resolutions, so DNS rebinding still gets through. Closing that needs the connection pinned to
the address that was checked (an undici dispatcher, not a wrapper). This stops the whole class
of direct attempts, which is what every one of those addresses is.

### `pathLock.js`
Serializes canonical writes. Pure — imports nothing, holds no path knowledge beyond using the
string as a key, and is exercised without a SQLite binary in `tests/conflicts.test.js`.

`db.transaction()` already makes the derived index safe from interleaving, but a canonical write
touches the **filesystem** before it opens that transaction (`documents.updateFile` writes body
and sidecar, then syncs the index; `move()` moves on disk first and rolls back by hand if the
transaction throws). The filesystem has no transaction to borrow, so the serialization has to be
explicit.

- `withDocument(relPath, fn)` — shared on the tree, exclusive on that path. Two writes to one
  document never overlap; writes to different documents stay fully concurrent, which is the
  whole point on a shared vault.
- `withStructure(fn)` — exclusive on the whole tree. Used by `move`/`rename`/`delete`/`copy`,
  because the paths those invalidate are not knowable from the operation alone (moving a folder
  renames everything beneath it). Creation deliberately does **not** take it: it only *adds*
  paths, so it invalidates nothing anyone is holding — and `importPackage` calls
  `updateMetadata` internally, which would deadlock against a lock it already held.

Lock order is always **path lock first, database lock second**; `highlights.js` follows the same
order for the same reason. It is an **in-process** lock: right for the desktop app and for a
server host (one API process each), and explicitly not a file lock — two API processes over one
vault stay unsupported, and out-of-band writes are the Vault Doctor's problem.

**Deck files take the lock too, and the reason is specific.** `documents.js`, `highlights.js`
and `decks.js` all take a path lock on every canonical write. For deck files the key is the
deck's workspace-relative path (`_decks/<uuid>.json`) — the lock keys on an opaque string and
does not care that the path is not a document, and per-deck keys keep unrelated decks
concurrent.

It is worth being precise about what it protects, because the obvious answer is wrong. A plain
read-modify-write in `decks.js` cannot interleave: `_read` and `_write` are both synchronous
and nothing awaits between them, so a single thread makes the pair atomic. That is an accident
of the current statement order rather than a maintained property — one `await` added between
the read and the write reintroduces the race with nothing to catch it.

The reachable bug is the **optimistic write plus rollback** in `addEntry` and `removeEntry`.
Both write the deck file *before* opening their database transaction and, if it throws, rewrite
it from the in-memory snapshot they took beforehand. A concurrent `addEntry` on the same deck
lands during that transaction; the failing one then rolls back to a state that never existed
and erases it. A *failed* request destroys a *successful* one's work, and the file ends up
holding fewer entries than `DeckEntries` does — which `diagnoseDecks()` reports as an
`entryMismatch` and `repairFromFiles()` resolves toward the file, making the loss permanent.
Unreachable on the desktop (one renderer, one request at a time); reachable on a **server
build**, where two collaborators adding cards to one deck is ordinary. `tests/conflicts.test.js`
pins it, and the test fails if the lock is removed.

**The lock is not reentrant, so `decks.js` takes exactly one per operation.** Every public
mutator wraps its body through `_withDeckFile`; the private helpers (`_read`, `_write`,
`_readOrRebuild`, `_ensureSystemDeckFile`) take none. That is why `createStandaloneCard` calls
`_readOrRebuild` instead of the `_ensureSystemDeckFile` + `_read` pair it used to — the pair
touched two keys — and why `updateDeck` no longer ensures a file it does not write.
`removeCardEverywhere` is deliberately unlocked: it loops over `removeEntry`, which locks each
deck on its own, and locking the loop as well would re-enter on the first deck's key. The
cross-module call chains are safe because they compose sequentially rather than nesting:
`routes/decks.js`'s purge calls `documents.deleteFlashcard` (a different key) *after* the deck
call returns, and `ankiImport.js` calls `createDeck`/`createStandaloneCard`/`addEntry` in a loop
while holding no lock of its own.

**Still uncovered: the Vault Doctor.** `repairFromFiles`, `rebuildFromFiles` and `mapDeckFiles`
rewrite every deck file without a lock. `mapDeckFiles` is safe by timing — `UpdateRunner` runs
it at boot, before the server accepts a request. The two Doctor entry points are not, but they
are part of a larger gap: `doctor.js` takes no path lock anywhere, and it rewrites documents as
well as decks. Fixing that is a Doctor-wide question (it most likely wants `withStructure`
around a whole run) and does not belong in `decks.js`.

---

### `cardRemovalBudget.js`
How many flashcards one account may delete, per request and per rolling hour. Pure — imports
nothing at all — so `tests/cardRemovalBudget.test.js` runs with no vault and no native module,
like `pathLock.js` and `safeFetch.js`.

`PUT /api/documents/metadata` is COLLABORATOR-gated on purpose: cards, highlights and tags all
live in the sidecar, so a collaborator who could not write metadata could not annotate. But the
write is a whole-object replacement, and `documents._syncDocumentFlashcards` deletes every
indexed card absent from what arrived — so `{"flashcards": []}` erased a document's entire card
set, canonical file and index together, from the role meant to annotate rather than reshape.

Removing a card *is* annotating, so the operation stays open and the **volume** is bounded
instead. Two limits: **per request** (the one that matters — it makes "delete this document's
two hundred cards in one call" impossible) and **per rolling hour** (bounds a patient caller,
turning an instant wipe into something slow enough to notice). Admins and the Author are exempt.

- `check(accountId, count, limits)` — verdict only, no state change.
- `consume(accountId, count)` — charges the budget, called only after the write succeeds.

**This is a rate limit, not an authorization boundary.** The role table is still the boundary;
this stops that boundary's one deliberately-wide door from being a trapdoor. The counter lives
in this process and resets on restart — the same honesty as `pathLock.js`, and the right scope
given one API process per vault, but it is not a durable quota. Limits come from
`config.getCardRemovalLimits()` (`cardRemovalsPerHour` / `cardRemovalsPerRequest`, defaults 20
and 10), read fresh from disk so tightening them after an incident needs no restart.

---

## Tier 3 — Orchestration

### `documents.js`
Main orchestrator. Coordinates `files`, `query`, `srs`, and `SealEventEmitter` atomically. Handles: `createFile`, `createFolder`, `importFile`, `importPackage`/`exportPackage`, `move`, `copy`, `rename`, `delete`, `readFile`, `updateFile`, `updateMetadata`, `listFolder`, `search`, `getGraph`, `createFlashcard`/`updateFlashcard`/`deleteFlashcard` (the single-card sidecar writes — they exist here so the read and the write happen in one server operation; a client doing its own fetch-splice-save on a sidecar reverts whatever else landed on it in between), `addMediaToFlashcard`, `syncDocumentLinks` (parses `flashback://` links out of saved Markdown, mirrors them into the sidecar's `links[]` and materializes `Connections`/queues them in `DocumentLinks`). All writes use the `db.transaction(() => { ... })()` IIFE pattern and emit a Seal commit afterward.

**Web clips.** `createClip`/`setClipSource` fetch a page, run it through Readability, sanitize it, and store the result as a `.clip` body. They download **nothing else**: the article's pictures and sound keep the absolute URLs Readability resolved and load from their own host as the clip is read. Mirroring a page's forty assets up front was slow and is exactly the burst asset hosts rate-limit, so an asset is fetched only when it is wanted — `saveClipAsset(relPath, href)` downloads one into `<folder>/media/`, registers it in `Media`, rewrites that `src` to `./media/clip-<hash>.<ext>` and seals the edit. The `href` must already be a src in that clip's body (resolved by the same addressing rules `mcpReader.mediaBuffer` uses: full src, `./`-less src, or bare file name), which is what stops the route above it from being a downloader for arbitrary URLs. It is a no-op for an href already local, so callers can save unconditionally. A sound published as a **link** rather than an `<audio>` (how Wikipedia renders every player) is saved the same way and the anchor becomes a real `<audio>` on the way in, so the clip plays what the page could only point at and everything downstream sees the shape it already knows.

**Link write ordering (important):** the sidecar's `links[]` array is derived from content but stored on disk, so it must be written *before* the operation's Seal commit — otherwise the post-commit link write leaves the sidecar permanently diverged from its sealed version (out-of-band drift that the Loose-pages panel and Vault Doctor report forever). `importFile` folds links into the sidecar before `sealEmitter.create`; `syncDocumentLinks` (the live-save path) only rewrites + reseals the sidecar when the links actually changed. `indexDocumentLinks(relPath)` is the **read-only** variant (Vault Doctor): it re-derives the DB `Connections` from content without writing the sidecar or emitting a Seal event.

The DB-registration core of `importFile` is factored out as `_registerDocumentDerived({name, fileRelPath, absPath, encoding, metadata})` (row + inheritance + tags + flashcards + highlights in one transaction; no filesystem writes, no Seal). It is shared with a set of **read-only indexing methods** used by the Vault Doctor — these re-derive the index from the on-disk files without writing document content, regenerating identities, or emitting Seal events:
- `indexDocument(relPath)` — index an on-disk document that has no DB row (delegates to `reindexDocument` if a row already exists); adopts the sidecar's `globalHash`, ensures ancestor folders exist, then resolves pending `flashback://` links.
- `reindexDocument(relPath)` — refresh an existing document's rows from its sidecar: adopt the sidecar `globalHash`, max-merge flashcard SRS state (a level lowered out-of-band never regresses the DB), and replace tags/highlights/links wholesale so out-of-band removals propagate.
- `indexFolder(relPath)` — ensure a folder row exists (`''` = the workspace root) and re-run tag inheritance; recursive top-down.
- `removeFromIndex(relPath, isFolder)` — drop the index rows for a path deleted on disk (no filesystem writes).

### `srs.js`
Handles spaced-repetition review submissions. `submitReview()` updates `Flashcards` and inserts into `ReviewLogs` in a single transaction; the client computes the new level/ease (see `DATAMODEL.md`), the server just persists it. `getLeitnerStats()`/`getDue()` return box distribution, mastery percentage, and scoped due-card queries. `migrateProgress()` remaps existing cards between the Leitner and SM-2 algorithms. `detectAlgorithm()` answers "which scheduler is this vault on?" from `ReviewLogs.algorithm` — the active algorithm is a browser preference, so it is the default for `getDue()`/`getStatistics()`/`getCardInsights()` whenever the caller (the MCP server, a script) can't supply one. `getCardInsights(hash, {algorithm})` is the per-card counterpart of `getStatistics`: one card's schedule, its full review ledger (synthetic rebuild rows flagged, not counted) and a server-sampled retention curve — honest `retrievability()` under FSRS, and an explicitly-labelled approximation from the scheduled interval under Leitner/SM-2, which have no memory model. The scheduled-interval helpers (`intervalOfCard`/`isReviewedCard`/`dueDateOfCard`) sit at module scope and are shared by both, so the arithmetic exists here once — the only other copy is the SQL in `query.getDueFlashcards`. Calls `query` and `database` only — never imports `documents.js`.

### `diary.js`
Per-day study **diary** orchestrator (see `DATAMODEL.md` § Diary). Derives an idempotent, cumulative daily **summary** from `ReviewLogs` (`buildSummary`/`generateSummary`/`rebuildAll`) and stores optional user **entries** (`saveEntry`/`getEntry`), plus `getSummary`/`list`. Imports `config` and `query`, plus the bare `LEARNING_REVIEWS` constant from `srs.js` (so the daily pass-rate split matches the Stats view) — never the SRS service itself.

Two deliberate departures from the usual rules, both justified by the diary living **outside the workspace**:
- **It is the one Tier-3 module that writes files directly** (atomic temp+rename) instead of going through `files.js`. `files.js` owns `.flashback` *sidecars under `workspaceRoot`*; diary files are neither sidecars nor inside the workspace, so `files.safePath` doesn't apply. Diary paths derive from `config.getVaultPath()` → `{vault}/diary/{summaries,entries}/`.
- **It has its own `isomorphic-git` repo** at `{vault}/diary/`, independent of Seal (whose repo root is the workspace). Commits use the same `<action>: <path>` convention with actions `summary` and `entry`. The repo is initialized lazily on first write, never at startup — the feature is opt-in on the client (localStorage), and the server must not create `diary/` for an opted-out vault.

Because the diary is a sibling of `workspace/`, it is automatically absent from `files.walkWorkspace()`, the SQLite index, global search, and the knowledge graph — no exclusion code, pinned by a test in `tests/diary.test.js`.

### `mcpReader.js`
Read-only **text extraction** — plus the **media** a document carries (an EPUB's figures, a saved clip's pictures and sound) — for documents the app renders but cannot decode as text. `files.readFile` deliberately refuses to decode a binary; this is the sanctioned way to get actual prose out of one. Singleton export (like `diary.js`) so its extraction cache is shared. Imports **`files.js` only** — no database, no `query.js`, no `documents.js` — and is read-only toward the canonical layer, like `doctor.js`. Heavy parsers (`pdfjs-dist`, `adm-zip`, `jsdom`) are lazily `await import`ed on first use (the `documents._buildClipDoc` precedent), so a vault with no PDFs pays nothing at startup.

- `info(relPath)` → `{ format, unit, total, extractable, note?, sections?, images?, media? }` — `images` is a count (EPUB only) and `media` is `{ total, images, audio }` (clip only), each enough to know whether listing them is worth a call.
- `read(relPath, { index, count, offset, limit, charOffset, at })` → one envelope for every format: `{ format, unit, index, total, label, text, hasMore, next, nextCharOffset, truncated }`.
- `images(relPath)` → `{ path, format, total, images: [{ index, href, name, mediaType, bytes, alt, caption, section, sectionIndex, isCover }] }`, EPUB only (415 otherwise). Collected during the same OPF/spine walk as the text, so it rides the extraction cache. Ordered by **first appearance in reading order**, with manifest-only images (a cover named just by metadata, leftover assets) appended. Section images are scanned *before* the empty-text skip, because a plate or a cover page is exactly a section with a picture and no prose; those get a `section` label but a null `sectionIndex`, since they have no readable unit to address.
- `imageBuffer(relPath, href)` → `{ buffer, mediaType, name, bytes }`. **Never cached** — one full-page plate would swamp a budget sized for text. Only an href the OPF manifest declares as an image can be read: that allow-list, not path arithmetic, is what keeps this from being "read any entry in any zip". Addressing accepts the full archive path, the bare file name, or the section-relative `src` an author wrote; an ambiguous match is a 400 rather than a guess, because quietly serving the wrong figure would end up on a card and not be noticed until review.
- `media(relPath)` → `{ path, format, total, media: [...] }` — the general form of `images()`, serving an EPUB's figures and a clip's assets alike so one picker can browse either. Every entry carries `kind` (`image`\|`audio`), `href`, and the context that identifies it without looking (alt, caption, plus `section`/`sectionIndex`/`isCover` for a book or `heading` for a clip). Clip entries add `cached` and a real workspace-relative `path`; a book figure's `path` is always null, because it lives inside the zip. 415 for any other format.
- `mediaBuffer(relPath, href)` → `{ buffer, mediaType, name, bytes, kind }`. Delegates to `imageBuffer` for an EPUB; for a clip it reads the cached file through `files.readBuffer`, still gated on the derived list rather than on path arithmetic. An **uncached** clip asset — one still loading from the site it was clipped from, which is how every asset starts — is a 400, never a fetch: this module does no network IO, so it can never be turned into a proxy for arbitrary URLs.
- Addressing is by each format's **native unit**, because that is how these documents are referenced: PDF by `page` (1-based `index`, `count` for a few at once), EPUB by spine `section` (1-based index *or* the spine href), a YouTube transcript by timestamped `segment` (1-based `index`/`count`, *or* `at`=seconds to land on the block covering a moment — how a `video_timestamp` highlight resolves), Markdown/text/clips by `chars` window (`offset`/`limit`). Responses are capped at `MAX_CHARS`; a single oversized unit sets `truncated` and is resumed with `nextCharOffset`.
- Formats: `.md`/`.markdown`/`.txt`/`.text` (via `files.readFile`), `.pdf` (pdfjs text layer), `.epub` (`container.xml` → OPF spine → XHTML), `.clip` (sanitized HTML flattened to prose, with its `<img>`/`<audio>` collected into a media list in the same parse), `.youtube` — the transcript stored in the sidecar's `source.transcript` (fetched by `documents.fetchYoutubeTranscript`), grouped into timestamped `segment` blocks; a `.youtube` with no transcript yet reads as a short `chars` note pointing at the fetch tool. It reads the sidecar via `files.getMetadata`. Anything else raises a 415-tagged error. Errors carry an HTTP `status` (404/415/400) that `routes/reader.js` passes straight through.
- Extraction results are cached in memory, keyed by `relPath + mtimeMs + size` so an edited file invalidates itself, capped by entry count and total characters. **Nothing is cached to disk** — a cache file inside `workspace/` would surface as a stray item in the Vault Doctor and in Seal.

**What it deliberately does not do:** produce highlight anchors. A highlight has to land in the coordinate system its renderer paints from (PDF text-layer bboxes, an epub.js CFI generated from the live iframe DOM), and neither is faithfully computable server-side. Cards don't need one — `create_flashcard`'s `highlightHash` is optional — so an assistant can read a book and draft cards from it while anchoring stays a reading gesture the user makes in the app.

### `readProgress.js`
**Where one person has read to.** Singleton export. The only module that knows both a document's *identity* and a reading *unit* — the unit vocabulary belongs to the reader and the identity belongs to the index, which is why this is a module rather than a few methods on `documents.js`. Imports `query.js`, `files.js`, `accounts.js`, `vault.js` and `requestContext.js`. Full HTTP surface in `API.md` § Read progress; data model in `DATAMODEL.md` § Read progress.

Stored in **`accounts.db` for everyone, the owner included**, under the same `OWNER_SCOPE` sentinel. That is deliberately *not* the split `srs.js` makes, and the two reasons are specific to reading: a position moves continuously, so sidecar storage would turn reading into a commit stream (`seal.js` already argues the weaker version of this for reviews), and a Reader cannot write a sidecar at all, since `PUT /api/documents/metadata` is COLLABORATOR-gated. **A write here produces no file and no Seal commit** — reading is not editing. Nothing is derived into the vault database, so a Doctor rebuild neither restores nor destroys it.

- `get(relPath, { scope })` / `set(relPath, { unit, position, percent, total, mode }, { scope })` / `clear(relPath, { scope })`
- `listInProgress({ scope, limit, includeFinished })` — what the caller is partway through.
- `rollup(folderRelPath, { scope, rows })` / `folderRollup(...)` — a subtree aggregate, labelled with the magazine when the folder is a subscription's `target_path`. That label is the entirety of what a "subscription rollup" is: `Subscriptions` is a publisher-side record with no account scoping and no completion notion, so per-person progress over its folder is the only place the answer can come from.
- `listForFolder(folderRelPath, { scope, folders })` — one folder listing's progress in one call, mirroring `listFolder`'s shape so the explorer never issues a request per node.
- `coverage(relPath, { scope })` — the span read but not carded. Cards are vault-wide (only *schedules* are personal), so the carded depth is unscoped; it is read from the sidecar because a highlight-anchored card keeps its position on the highlight. Returns `cardedTo: null` for `section` units, since CFIs are not orderable without epub.js.

**Positions are keyed by the CANONICAL `globalHash`, read from the sidecar** — not by `Documents.global_hash`, which is derived and can disagree with it (`importFile` does not always carry a caller-supplied hash into the index). A Doctor rebuild re-derives that column *from* the sidecar, so a position keyed to the indexed value would be silently orphaned by a rebuild. When `set()` finds the two disagree it corrects the indexed column toward the canonical one, which is what the Doctor would do anyway, and is what lets every rollup join plainly on the index.

`total` is always supplied by the caller and never computed here: `mcpReader.info()` performs a full extraction, so deriving a denominator on read would make a folder listing parse every PDF in it.

### `cardHealth.js`
**Failure-signature classification** — decides which failing cards are worth acting on, and says why. Singleton export (like `diary.js`/`mcpReader.js`) so its baseline and session caches are shared. Full data model in `DATAMODEL.md` § Card Health.

The problem it solves: two cards can have an identical pass rate and need opposite treatment. A **mouthful** is badly built (too much to hold at once → split it); a **probe** is hard because it forces the reviewer to confront a wrong assumption (failures are the mechanism → keep it, optionally add a companion card naming the misconception). Discriminating them needs the **derivative, not the level** — a probe's relearn cycles each end at a longer interval and its FSRS difficulty plateaus or falls, while a mouthful oscillates around a floor with difficulty ratcheting up.

Two further detectors ship as **guards**, and they are not extras — they are what stops `mouthful` from being wrong. `overdue_drift` (the card failed because it surfaced weeks past due) and `session_fatigue` (it only fails in the last third of long sessions, and passes when it comes up early) each mean the trajectory evidence is contaminated; when either fires it **suppresses** the mouthful/probe verdict. The guard is the diagnosis.

- **Structure.** The impure work happens once in `buildContext(hash)` → `{ card, structure, reviews, epoch, trajectory, repeatFailure }`; every detector in the `DETECTORS` registry is a pure `(ctx) => flag | null`. Adding a detector is one array entry plus a test — which is why the evidence gathering deliberately does not live inside the detectors. `tests/cardHealth.test.js` drives them from hand-built contexts with no database at all.
- **Runs on failure only.** `onReview(hash, {outcome, rating})` classifies when a card has just failed; there is no reason to guess at why a card is failing when it isn't. A **passing** review clears its flags only once the card reaches `RECOVERY_LEVEL` (3) — a single pass is not recovery, because a mouthful passes constantly at a one-day interval, which is the behaviour being flagged.
- **Addressing restarts the analysis.** `CardHealth.epoch_at` is a watermark: after an edit, a recovery or a dismiss, reviews at or before it stop being evidence. History from before a fix is never held against the card that replaced it. Edits are detected by **content fingerprint** inside `buildContext`, not by a hook, so an edit through *any* path — the PUT route, MCP, a Seal rollback, a Doctor reindex — resets the window; `onCardEdited()` exists only so the flag disappears the instant the user saves.
- **Honest about its own limits.** Leitner and SM-2 record no difficulty signal, so a verdict reached without one is capped one confidence step lower and reports `memoryModel: 'approximated'` in its evidence — the same honesty the retention curve applies. Every flag carries the numbers behind it (peak-interval series, difficulty slope, answer tokens vs. vault median, overdue ratios) so the user can disagree with it rather than being handed an oracle.
- **Never auto-splits, never auto-buries.** A flag ends in a named recommendation, never an applied change.
- **Derived, never canonical.** Flags live only in SQLite and are absent from `.flashback` sidecars — they are recomputable, and sealing one would mean a git commit on every failed review. `query.wipeDerivedContent()` clears them with `ReviewLogs`, so a **Vault Doctor `rebuildIndex` destroys card health along with the review history it rests on**; cards re-earn their flags from new review behaviour. That is a real limitation, not an oversight.

### `sequencer.js` / `sequencing.js`
**Presentation order** — decides the sequence a session's due cards are shown in, never which cards are due. Full model in `DATAMODEL.md` § Session Sequencing.

The split mirrors `srs.js`/`fsrs.js`: `sequencing.js` is the pure engine (constants, `distance`, `feasibleLag`, `orderCards`) and imports nothing, so `tests/sequencing.test.js` pins its behaviour with no SQLite binary; `sequencer.js` is the thin DB-facing half that fetches facets and stamps a `sessionId`.

- **Interleaves, doesn't cluster.** Graph proximity is a *spacing* signal. Cards at distance ≤ 1 (same document, shared tag, same parent folder) are pushed at least `MIN_LAG` apart; they still co-occur in the session, because that's where discrimination is learned.
- **Degrades to shuffle, never to clusters.** The ladder is `none` → `no-folder-edge` → `short-lag` → `shuffle`, reported as `relaxation` on the response. A shuffle is already better than blocking, so every failure mode ends there.
- **Asks the geometry before enforcing the lag.** Spacing *k* cluster-mates *g* apart in *n* slots needs `(k-1)(g+1)+1 ≤ n`; `feasibleLag()` computes the achievable lag per tier. A greedy told to honour an impossible lag spends its buffer early and piles the remainder into a block at the end — reintroducing exactly what the module exists to prevent.
- **`measureOrdering()` is the telemetry half**, called from `routes/srs.js` on each review. It derives `prev_distance`/`nearest_sibling_lag` from `prevCardHash` — what the trainer *actually* showed — not from the planned order, because a card re-queued after a failed grade lands somewhere nobody planned. Best-effort by construction: it returns nulls rather than throwing, since telemetry must never cost a graded review.

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
Orchestrator for user-curated card collections, and the **only** place standalone (document-less) flashcards are created/edited/deleted. Each deck is dual-written: a canonical JSON file at `workspace/_decks/<uuid>.json` (the Seal-tracked source of truth) and mirrored `Decks`/`DeckEntries` rows in the DB; the JSON write happens first and is rolled back if the DB write fails, keeping the two in sync. One deck is flagged `is_system` (auto-created by migration `003_system_deck.js`, protected from deletion) — it's the home for every standalone card. Key methods: `listDecks`, `createDeck`/`updateDeck`/`deleteDeck`, `addEntry`/`removeEntry` (also maintains a `deck`-type graph connection between the deck's node and the card's node), `searchCards` (cross-deck card search used by the "Add cards" panel; sortable by `level`/`name`/`last_recall`/`lapses`/`difficulty`, the last two FSRS-only and NULL for cards never rated under it — `difficulty` sorts those to the bottom in both directions rather than letting SQLite float the NULLs), `getCard` (one card resolved to content + `documentPath` + its stored `media` references — refs as written in the sidecar, never URLs), `createStandaloneCard`/`updateStandaloneCard`/`deleteStandaloneCard` (reject the call if the target card turns out to be document-linked, directing the caller to edit it from its document instead; updates are partial — omitted fields keep their stored values). Standalone-card create/update also snapshots the card's content into the deck JSON entry and `DeckEntries.inline_card`, so a rebuild can restore document-less cards from files alone.

Every deck-JSON write emits a Seal event (`decks.js` imports `sealEmitter`) so deck CRUD and standalone-card edits are versioned and rollback-able alongside documents, using the same `<action>: <path>` convention against the `_decks/<uuid>.json` path: `createDeck` → `create:`, `deleteDeck` → `delete:`, and everything else (`updateDeck`, `addEntry`/`removeEntry`, and all standalone-card ops, which edit the system deck's file) → a **debounced** `edit:` so a bulk card import batches into one commit instead of one-per-card. The Vault Doctor's `repairFromFiles`/`rebuildFromFiles` deliberately stay unsealed — the Doctor binds its own out-of-band changes into a single `reconcile:` commit at the end of a sync.

Canonical-update helper (used by `config/UpdateRunner.js`): `mapDeckFiles(transform)` applies a transform to every deck file, rewriting only the ones it changed plus their `DeckEntries.inline_card` mirrors, reporting rather than overwriting files it could not parse or whose transform threw, and emitting no Seal event of its own (the caller commits the whole pass at once).

Vault-Doctor helpers (used by `doctor.js`): `listDeckFiles()` (all `_decks/*.json` payloads), `diagnoseDecks()` (`{fileWithoutDb, dbWithoutFile, corruptFiles, entryMismatches, danglingEntries}`), `repairFromFiles()` (reconcile DB to the deck files — file wins on entry mismatch), and `rebuildFromFiles()` (re-import every deck file, restore standalone cards from their inline snapshots, and guarantee exactly one system deck).

### `highlights.js`
Orchestrator for document-scoped highlights — a highlight is a first-class entity (own DB row + sidecar entry) independent of any flashcard; a flashcard optionally anchors to one via a `{type: 'highlight', id: <sidecar id>}` reference (see `DATAMODEL.md`). Key methods: `getHighlights(relPath)`, `createHighlight`/`updateHighlight`/`deleteHighlight` (sidecar + `Highlights` table together), `listAnnotated({path?, color?, uncardedOnly?})` (vault-wide or per-document listing enriched with the highlighted text, ~200 chars of surrounding body context for `.md`/`.txt` documents via `files.readFile`, and the flashcards anchored to each highlight — computed from the sidecar's `flashcards[].vanillaData.location` merged with the highlight's own `cardHashes[]`; document discovery uses the derived `Highlights` table, detail always comes from the sidecar), and `syncFromSidecar(documentId, highlightsData)` (reconciles the DB's `Highlights` rows for a document against its sidecar's `highlights[]` array on every save — inserts new ones, deletes ones no longer present).

### `doctor.js` (Vault Doctor)
Keeps the derived SQLite index consistent with the canonical `.flashback` layer. The index can drift from disk via out-of-band edits, Seal rollbacks, crashes, or DB corruption; the Doctor closes that loop with three operations (mounted at `/api/doctor`):
- `checkIndex()` — read-only whole-vault report. A **direct workspace-walk ↔ DB comparison** (via `files.walkWorkspace()`), *not* `sealTools.inspect()`, which diffs against git HEAD and is blind right after a rollback (HEAD == workdir while the index is maximally diverged); git drift is included as supplementary context only. Reports folders/documents `missingInDb`/`orphanedInDb`, `modified` (with reasons), `hashConflicts` (duplicate `globalHash`), media both directions, deck diagnosis, and counts. All cross-layer joins normalize `relative_path` to `/` once (the DB stores `path.sep`, git uses `/` — the #1 trap).
- `syncIndex({sealDrift=true})` — applies the report; **disk is the source of truth**. Indexes new items, reindexes modified ones (SRS max-merge, never regresses progress), removes rows for deleted items, reconciles media both directions, repairs decks. Skips (never auto-resolves) hash conflicts, corrupt sidecars, and untracked files, reporting them instead — a `globalHash` is never regenerated. By default seals remaining out-of-band drift into one `reconcile:` commit (`sealTools.commitDrift()`). Idempotent. Refuses to run if `PRAGMA integrity_check` fails, directing the caller to rebuild.
- `rebuildIndex()` — nuclear option. Wipes all derived content (`query.wipeDerivedContent()`, keeping only schema/seed tables) and re-indexes the entire canonical layer. Pre-creates any missing card categories (unknown categories are silently dropped at insert), restores standalone cards from deck inline snapshots, and re-seeds one synthetic `ReviewLogs` row per card to preserve its SM-2 ease. ReviewLogs *history* does not survive (levels and ease do, via the sidecars). Rerunnable but not atomic past the wipe: per-item failures collect into `warnings`.

---

## Tier 3 — Package Import (built on the orchestration tier)

These two modules parse a third-party archive format and populate decks/documents/media from it. They're dynamically `import()`-ed by `routes/documents.js` only when an import request actually needs them (avoids loading `better-sqlite3`'s Anki-DB-reading path and `adm-zip` parsing on every server start).

### `ankiPackage.js`
Pure reader for the `.apkg` container — no DB, no sidecars, no imports from `access/`. It exists so `ankiImport.js` never has to know which of the three package generations it was handed:

| Generation | Zip contents | Media map | zstd |
|---|---|---|---|
| Legacy1 (Anki 2.0) | `collection.anki2` + numbered files | `media` = JSON | no |
| Legacy2 (2.1.0–2.1.49) | `collection.anki21` | same JSON | no |
| Latest (2.1.50+, today's default) | `meta` + `collection.anki21b` | `media` = protobuf `MediaEntries` | yes — collection, media map and every asset |

`openPackage(buffer, tempRoot)` extracts and returns `{ version, zstd, collectionPath, mediaMap, tempRoot }`; `readCollection(ankiDb)` returns `{ decks, models }`; `readMediaFile(tempRoot, entry)` returns an asset's **decompressed** bytes.

Two format details drive the whole module. First, schema 15+ replaced the `col` JSON blob with `notetypes`/`fields`/`templates`/`decks` tables and moved the interesting settings into protobuf BLOBs in a `config` column — `templates.config` holds `q_format = 1` / `a_format = 2`, `notetypes.config` holds `kind = 1` (0 normal, 1 cloze) / `sort_field_idx = 2` / `css = 3`, `fields.config` holds `description = 5`. There is no `kind` *column*, so without decoding that BLOB every modern notetype degrades to a positional basic card. A ~60-line varint reader handles it (skipping unknown fields by wire type, so a future Anki schema bump doesn't break it) rather than pulling in a protobuf runtime for five scalars. Second, zstd comes from `node:zlib` — present in both Electron's Node and system Node — so this needs no dependency.

Everything normalizes onto the *legacy* JSON shape, including deck names, which schema 15+ nests with `\x1f` instead of `::`. `readCollection` is also where zstd assets get decompressed before hashing, so the same asset imported from a legacy and a modern package dedupes to one `Media` row.

### `ankiImport.js`
Projects Anki notes onto Flashback cards. Anki notetypes declare arbitrary named fields and let their templates decide where each renders; Flashback has five card types with fixed slots, so the projection is lossy and the user gets to steer it. Two phases:

- `analyze(buffer)` reads the package without importing, and returns each notetype's fields, sample notes, and a **suggested** field→slot mapping derived by reading the notetype's own `qfmt`/`afmt` backwards. It leaves the extraction on disk under a `sessionId` (in `os.tmpdir()/flashback_anki_imports/`, swept after an hour) so the apply phase needs no second upload.
- `importApkg(buffer|null, targetRelPath, mapping, sessionId)` applies `{ [notetypeId]: { cardType, slots } }`. Omitting `mapping` falls back to the same suggestion, so there is one code path and every existing caller keeps working.
- `readSessionMedia(sessionId, name)` returns one asset out of a live session, decompressed, by its original Anki filename. It exists so the mapping UI can *preview* media — the front/back sound decision can't be made without hearing it. Read-only: nothing reaches the vault until the apply phase.

Slot rules: several fields may share a slot and concatenate in order; a field in a text slot keeps its text while media found inside it still fills the matching media slot; a field in a media slot contributes only its first asset; a field in no slot is dropped. Anki notes still become Flashback cards 1:1, so multi-template and multi-cloze notes collapse to one card.

Talks to `ankiPackage.js` (all format reading), `files.js` (media directory resolution), `query.js` (media dedup lookups, direct card/media inserts), and `decks.js` (deck lookup-or-create, `addEntry`/`createStandaloneCard`) — it never imports `documents.js`, because Anki cards have no source document. `targetRelPath` is accepted for signature parity with the other importers and deliberately ignored.

### `obsidianImport.js`
Parses an Obsidian vault `.zip` into a mirrored folder tree of real documents. Talks to `documents.js` (`createFolder`/`importFile` — this is the actual document creation path) plus `files.js`/`query.js` directly for extras that don't fit the single-document `importFile` call: per-folder `media/` copying and DB registration, and frontmatter/wikilink/tag extraction ahead of each file's import.
