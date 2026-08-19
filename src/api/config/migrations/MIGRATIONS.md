# Migrations

Schema migrations for Flashback. Each file upgrades the database from one
version to the next. The runner (`MigrationRunner.js`) tracks which migrations
have been applied in the `SchemaVersion` table and runs only pending ones.

---

## When to write a migration

Write a migration when you need to change the schema of an **existing** production
database. For pre-beta development you can usually just delete and
recreate the local database instead.

Changes that require a migration:

- Adding a column, table, or index that is not yet in `SchemaSQL.js`
- Seeding new default data (e.g. a new `NodeType` or `ConnectionType`)
- Backfilling data for a structural change (e.g. computing a new column from
  existing rows)

Changes that do NOT need a migration:

- Anything already in `SchemaSQL.js` with `IF NOT EXISTS` — those run on every
  startup and handle fresh databases automatically
- Pure code changes with no schema impact

---

## File naming

```
NNN_short_description.js
```

- `NNN` is a zero-padded integer starting at `001`, incrementing by one.
- Use snake_case for the description.
- Never reuse or reorder numbers — the runner relies on the version field, not
  the filename, but consistent naming makes the history readable.

---

## File structure

```js
export const version = 1;          // Must match NNN exactly
export const description = '...';  // One-line human-readable summary

export function up(db) {
    // db is the better-sqlite3 connection.
    // The runner wraps this in a transaction — do NOT open your own.
    // Use IF NOT EXISTS / existence checks so the function is idempotent.
}
```

See `001_pre_beta.js` for a full worked example covering column additions,
table creation, index creation, default data seeding, and data backfills.

---

## Registering a migration

After writing the file, add it to `MigrationRunner.js`:

```js
import * as m001 from './migrations/001_pre_beta.js';

const MIGRATIONS = [m001];
```

The runner filters to pending versions (not yet in `SchemaVersion`) and applies
them in ascending version order, one transaction per migration. A failed
migration aborts startup — fix the `up()` function and restart.

---

## Rules

1. **Never modify a migration that has already shipped.** Once a version is in
   `SchemaVersion` on a real database it will never run again. Fix forward with
   a new numbered migration.
2. **Keep `up()` idempotent.** Use `IF NOT EXISTS`, `INSERT ... WHERE NOT EXISTS`,
   and `PRAGMA table_info` checks. If the migration runs twice it must leave the
   database in the same state as running it once.
3. **No transactions inside `up()`.** The runner wraps the whole function in a
   transaction. Nested transactions will cause an error.
4. **Update `SchemaSQL.js` too.** Fresh databases are built from `SchemaSQL.js`,
   not from migrations. Every structural change must appear in both places so
   that new installs and upgraded installs end up identical.

---

## Current migrations

| Version | File                     | Description                                                             | Status     |
| ------- | ------------------------ | ------------------------------------------------------------------------ | ---------- |
| 1       | `001_pre_beta.js`        | Pre-beta schema changes: card columns, Highlights, indexes, Deck nodes   | Registered |
| 2       | `002_document_links.js`  | Inter-document links: DocumentLinks queue table + link ConnectionType    | Registered |
| 3       | `003_system_deck.js`     | System deck: is_system column on Decks + Cards deck seed                 | Registered |
| 4       | `004_fsrs.js`            | FSRS scheduler: card state columns, review snapshot, FsrsParameters      | Registered |
| 5       | `005_card_origin.js`     | Flashcard provenance: ensure Flashcards.origin column exists             | Registered |
| 6       | `006_review_algorithm.js`| ReviewLogs.algorithm: record the scheduler each review was graded with    | Registered |
| 7       | `007_card_health.js`     | Card health: CardHealth watermark + CardFlags failure signatures         | Registered |
| 8       | `008_type_answer_answer_text.js` | type_answer: FlashcardContent.answerText + CanonicalVersion table (pairs with canonical update 001) | Registered |
| 9       | `009_session_ordering.js` | ReviewLogs: session ordering telemetry (session_id, position, distances) | Registered |
| 10      | `010_per_account_progress.js` | Per-account SRS progress: CardProgress + account scope on logs, health, flags and FSRS weights | Registered |
| 11      | `011_drop_resurrected_srs_columns.js` | Drop the Flashcards SRS columns migration 004 could re-add after 010 | Registered |
| 12      | `012_reviewlogs_account_index.js` | ReviewLogs: composite (account_id, flashcard_id) index instead of account_id alone | Registered |

---

## Canonical updates are the other half

A migration here only ever touches this derived database. When a change also has to rewrite
the **canonical** layer — the `.flashback` sidecars and `_decks/*.json` files — that half
cannot live in an `up()`: it does file IO and a Seal commit, and the runner wraps `up()` in a
DB transaction. It goes in `../updates/` instead, run by `../UpdateRunner.js`. Same shape as
this folder — numbered modules, applied in order, recorded in `CanonicalVersion` — but
versioned **per file**, via a `formatVersion` stamp each canonical file carries. See
`../updates/UPDATES.md`.

Both halves must land on the same end state, or the next Vault Doctor rebuild re-derives the
database from the files and the two disagree. Reads should also stay correct if the canonical
pass has not run, since a Seal rollback can restore a pre-update sidecar at any time.
Migration 008 + update 001 is the worked example.

Migration 009 is the worked example of the **opposite** case: it adds columns to `ReviewLogs`,
which is derived-only — it lives in the database, never in a sidecar, and a Vault Doctor
rebuild wipes it. So there is no canonical half to write, and no downgrade warning to record:
an older build reading a migrated vault simply never selects the new columns.

The pair is also the worked example of a **one-way** change: update 001 empties a field an
older release still grades against, so a build from before `answerText` misreads a migrated
vault. Migration 008 alone is harmless there — old queries name their columns explicitly and
never see the new one — but the canonical half is not. When a pair has that property, record
it where `../updates/UPDATES.md` § One-way updates says to, and warn the user in
`CHANGELOG.md`.

## Migration 010 — the first one-way migration on its own

Every migration before it was additive: an older build opening a migrated vault simply never
selected the new columns. 010 is the first that **drops** columns — `Flashcards.level`,
`sm2_reps`, `last_recall` and the six `fsrs_*`, all moved into the new `CardProgress` table —
and an older build names those columns in a dozen statements. It fails loudly on a migrated
vault, which is the good outcome; the bad one would have been leaving them behind as dead
weight, where a query that forgot to scope itself would keep working and quietly serve one
person another person's schedule. `CHANGELOG.md` carries the downgrade warning, because
`electron-updater` only ever moves users forward and nothing else will tell someone who steps
back on purpose.

It has **no canonical half**. The sidecar format does not change: it already stores the owner's
progress in exactly these fields, and the owner is precisely whose progress a sidecar holds.

Two things it is worth copying from:

- **Backfilling to a literal.** Owner rows are stamped `'owner'`, never the Author's account
  id, so the migration needs no lookup into a second database and `openVault()`'s boot order is
  untouched. (The deeper reason for the sentinel is in `DATAMODEL.md` § Per-user progress.)
- **Rebuilding a table instead of altering it.** `CardHealth` and `CardFlags` needed a wider
  UNIQUE, and a UNIQUE declared inline in a `CREATE TABLE` is backed by an `sqlite_autoindex`
  that `DROP INDEX` cannot touch. Vaults carry one of two lineages there — 007's raw DDL or
  SchemaSQL's knex output — so a rebuild is both the only thing that works for the first and
  the only thing that leaves the two identical afterwards. `ALTER TABLE ... DROP COLUMN` also
  refuses while any index mentions the column, so 010 reads the index list out of
  `sqlite_master` and drops the offenders first rather than hardcoding names it cannot know.

## A dropped column makes every earlier guard a liability

Migration 010 dropped nine columns. Migration 004's `shouldRun()` asked

```js
return !cols.includes('fsrs_stability') || !hasTable;
```

which was correct for six years' worth of vaults and became wrong the instant 010 landed:
once the column is gone on purpose, that guard answers "still pending" on every boot, and 004
puts all six `fsrs_*` columns straight back — empty, unread, and exactly the stale-column trap
010 exists to remove. Migration 001 had the same shape for `sm2_reps`, firing on any rebuilt
database, where its `SchemaVersion` row is absent and `up()` runs regardless of the guard.

It was found on the first real vault, not by the suite, because a test that migrates **once**
cannot see it: 004 and 010 are sorted by version, so the resurrection lands on the *next*
launch. `tests/perUserSrs.test.js` now runs the migration runner three times over.

Three rules come out of it:

1. **Dropping a column is a change to every earlier migration that mentions it.** Grep for the
   name across `migrations/` and guard each hit; the migration you are writing is not the only
   one that will ever touch that column.
2. **Guard `up()` too, not just `shouldRun()`.** A migration whose `SchemaVersion` row is
   missing runs its `up()` unconditionally, and after a rebuild every row is missing while the
   schema is already modern.
3. **The guard to write is a positive test for the newer state** — "does `CardProgress` exist?"
   — never "is the old artifact missing?", which cannot tell "not yet built" from
   "deliberately removed".

Migration 011 is the repair for vaults an affected build already launched twice, and its
`shouldRun()` is deliberately open-ended: any doomed column found on `Flashcards` while
`CardProgress` exists gets dropped, however it got there.

## An index on the scope column alone is a trap

Adding `account_id` to a table invites indexing it. Do not index it on its own. A vault has one
account per person and most have exactly one, so the index matches every row and narrows
nothing — but SQLite does not know that without `ANALYZE`, and the planner will take any
equality match on an indexed column, abandoning a join order that was fine before.

Migration 010 did exactly this to `ReviewLogs`, and the diary paid for it: `getDayByDeck` joins
ReviewLogs → Flashcards → DeckEntries → Decks, and the planner switched to driving that join
from `DeckEntries` and re-searching ReviewLogs by account for every row. 24ms became 500ms, a
day's summary 120ms became 4s, and rebuilding the diary from history — one summary per active
day in a single request — went from about two seconds to minutes, which is indistinguishable
from a hang. Migration 012 replaces it with `(account_id, flashcard_id)`: the same first column
answers every account lookup, the second turns the join into a seek, and the query lands at
2ms — faster than before the scope column existed.

Index the scope column **as the first column of a composite**, paired with whatever the
queries actually join or filter on next. `tests/perUserSrs.test.js` asserts the shape, because
a timing test on this would be flaky and the shape is the real rule.

