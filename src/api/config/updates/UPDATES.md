# Canonical Updates

Versioned updates to the **canonical layer** — the `.flashback` sidecars and `_decks/*.json`
files that are the vault's source of truth. The document-driven counterpart of
`../migrations/`, which versions the derived SQLite database.

The runner (`../UpdateRunner.js`) applies pending updates in order and records them in the
`CanonicalVersion` table, the same shape `MigrationRunner` uses with `SchemaVersion`.

---

## Why this is not a migration

A schema migration receives one database handle and runs inside a transaction. A canonical
update rewrites files on disk and ends in a Seal commit — neither of which belongs in a DB
transaction, and neither of which a `db` handle can reach. So the two mechanisms are
deliberately separate, and deliberately shaped alike.

Most format changes need **both halves**, one per layer, landing on the same end state:

| Change | Derived half | Canonical half |
| ------ | ------------ | -------------- |
| `type_answer`'s `answerText` | migration `008` (column + backfill) | update `001` (rewrites the files) |

If only one half runs, the next Vault Doctor rebuild re-derives the database from the files
and the two disagree. Write them together.

---

## The version marker

Every canonical file carries **`formatVersion`**, an integer at the top of its metadata:

```json
{ "formatVersion": 1, "globalHash": "…", "flashcards": [] }
```

This is the real authority, and the reason the runner is per item rather than per vault. A
file is self-describing: one restored from a backup, synced in from another machine, or
recovered by a Seal rollback to a year-old commit still says exactly which updates it has
been through, and the runner brings just that file forward.

`CanonicalVersion` in the database records which updates the *vault* has finished. It exists
so a normal startup costs one indexed read instead of a walk over every sidecar — it is a
cache of "there is nothing to do", never the source of truth. Losing it (a Doctor rebuild, a
restored database) costs a redundant walk, not correctness.

A file with **no** `formatVersion` is version 0: it predates versioning, or a caller
assembled its metadata by hand. Both are treated the same — needing every update.

New files are stamped at creation, in `config/defaults/FlashbackFile.js`,
`FlashbackFolder.js`, and `Decks.createDeck()`. `Files.writeMetadata()` backstops callers
that build their own metadata object, but **only for a sidecar that does not exist yet**: an
existing file's stamp is a fact about its contents, and quietly marking an old file current
would tell the runner to skip data that still needs migrating.

---

## Writing an update

```
updates/NNN_short_description.js
```

- `NNN` is a zero-padded integer starting at `001`, incrementing by one.
- Register it in `updates/registry.js` — imports in order, never reordered or removed.

```js
export const version = 1;                  // must match NNN
export const description = '...';          // one-line human-readable summary

/**
 * @param {object} meta   the parsed canonical file: a sidecar's metadata, or a deck file
 * @param {'document'|'folder'|'deck'} kind
 * @returns {boolean} true when this update changed the file
 */
export function up(meta, kind) { }

/** Optional: bring the derived index in line afterwards. Must be idempotent. */
export function derived(query) { }
```

The runner owns the stamp — do not set `formatVersion` yourself.

---

## Rules

1. **Idempotent per item.** Not per run: per item. This is the load-bearing rule. The runner
   may hand an update a file that already went through it — a file created by a current
   build but never stamped, a vault whose `CanonicalVersion` was lost, a `force` re-walk.
   Detect work already done and return `false` rather than doing it twice. Update `001`
   keys off `answerText` already being present.
2. **Never modify a shipped update.** Once a version is in a real vault's `CanonicalVersion`
   and stamped on its files, it will not run there again. Fix forward with a new number.
3. **Never write over what you could not read.** The runner skips unparseable files and
   reports them; an update that throws leaves its file untouched. A skipped item means the
   vault record is *not* written, so the next launch tries again.
4. **Reads must stay correct when the update has not run.** A Seal rollback can restore a
   pre-update file at any moment, so the code that reads a format must tolerate both shapes.
   For `001` that is `typeAnswerParts()` in the UI and `answerBody()` in `cardHealth.js`.
   The update makes the vault tidy; it is not what makes the vault work.
5. **Keep `up()` pure and synchronous.** It transforms a plain object. All IO, ordering,
   stamping and sealing belong to the runner.
6. **Say so when an update is one-way.** See below — the header comment, the table, and
   `CHANGELOG.md` all have to carry it, because the user is the one who finds out.

---

## One-way updates

Rule 4 makes the *current* build tolerate an un-migrated file. It says nothing about an
**older** build reading a migrated one, and that direction is not free: a version that
predates the format has no fallback to reach for, because the shape it is being handed did
not exist when it was written.

An update is **one-way** when a previous release would read its output wrongly. Moving a
value between fields is one-way by construction; adding a field that old code ignores is not.
When an update is one-way, three things must record it:

- the update's own header comment, for whoever debugs it later;
- the **Downgrade** column below, so the property is visible at a glance;
- a "downgrading breaks X" section in `CHANGELOG.md`, which is what reaches the user.

There is no `down()`, and adding one would be a lie: the runner rewrites files and seals
them, so the honest reverse of a canonical update is a Seal rollback or a vault backup, not
a function. Say that in the changelog rather than implying an undo exists.

---

## Current updates

| Version | File                        | Description                                            | Status     | Downgrade |
| ------- | --------------------------- | ------------------------------------------------------ | ---------- | --------- |
| 1       | `001_type_answer_split.js`  | type_answer: move the compared answer from backText into answerText | Registered | **One-way** — pre-`answerText` builds grade against `backText`, which this empties |
