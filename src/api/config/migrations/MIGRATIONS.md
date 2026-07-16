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
