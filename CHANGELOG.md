# Changelog

## Unreleased

### Per-user spaced repetition

A vault can now be studied by more than one person without them grading each other's cards.

- Every schedule, review log, card-health verdict and fitted FSRS weight vector belongs to an
  **account**. Two people reviewing the same card diverge; neither one's grade moves the
  other's due list, retention numbers or streak.
- The owner's progress stays canonical in the `.flashback` sidecar exactly as before. Everyone
  else's lives in `accounts.db`, outside the vault, so a copied vault folder carries documents
  and the owner's history — never somebody else's study record and never an access list.
- A non-owner's review therefore **writes no file and produces no Seal commit**. Reading is not
  editing.
- `POST /api/srs/optimize` is now reader-level rather than admin-level. Fitted FSRS weights
  model one individual's forgetting curve and are stored per account, so refitting them changes
  nothing anyone else can see.
- The diary is per account: the owner keeps `diary/summaries` and `diary/entries` untouched,
  everyone else gets `diary/accounts/<accountId>/`. **One git repo still covers all of it**, so
  on a shared vault the diary is not a private local diary — treat it as a shared study log.

**On a single-user desktop install nothing above is visible.** There is one account, it is the
Author, and it may do everything — which is how Flashback has always behaved.

### Concurrent editing

Groundwork for a shared vault, and a real improvement on a single desktop too — two windows on
one document used to overwrite each other silently.

- A save that lost a race is now **refused rather than applied**. The editor keeps your draft
  and offers **Reload** (take what is on disk) or **Overwrite** (yours wins). Nothing is
  resolved automatically, because only the person who typed it knows which version matters.
- Editing different cards of the same document no longer collides. Card and highlight edits are
  applied by the server to the entity you named, so only two edits to the *same* card conflict.
- **Content edits are committed to Seal immediately**, in the order the requests arrived,
  instead of two seconds later. Grading cards still collapses into one commit per study
  session — that is the one write whose history nobody rolls back to. Authoring several cards
  in a row now produces one commit each, so you can roll back to any of them.

### Fixed

- The diary got slow enough to look broken. Migration 010 indexed `ReviewLogs.account_id` on
  its own; because every row of a one-person vault matches it, SQLite took that index and
  abandoned a good join order. A day's summary went from ~120ms to ~4s, and **Rebuild from
  history** — one summary per active day, in a single request — went from about two seconds to
  minutes, which reads as a hang. The index is now `(account_id, flashcard_id)` and the same
  work is faster than it was before per-account progress existed.
- Migrations 001 and 004 could put back the `Flashcards` SRS columns that migration 010
  removes. Their guards asked whether the old columns were missing, which stopped meaning
  "not built yet" and started meaning "deliberately dropped" — so on the second launch after
  upgrading, six empty `fsrs_*` columns reappeared beside the real values in `CardProgress`.
  Nothing read them and no schedule was affected, but a stale column that still reads is the
  exact failure the move was made to prevent. Both guards now test for the newer state, and
  migration 011 removes the columns from any vault that already acquired them.
- Startup no longer races its own schema work. `validate()` had become async without its callers
  awaiting it, so migrations could still be running when the first query arrived; a migration
  that threw surfaced as an unhandled rejection instead of a fatal startup error. Both are now
  awaited.

### ⚠️ Downgrade warning

This release **migrates the vault database one way** (migration 010). It moves nine columns off
`Flashcards` — `level`, `sm2_reps`, `last_recall` and the six `fsrs_*` — into a new
`CardProgress` table, and drops them from `Flashcards`.

**An older build cannot open a vault this release has opened.** It names those columns directly
and will fail with `no such column: level` on the Trainer, the Stats view and the card browser.
The failure is loud and nothing is corrupted, but the only ways back are to restore the vault
folder from a backup taken before the upgrade, or to stay on this version.

Back up `{userData}/{vaultName}/` before upgrading if you may want to step back. Back up
`{userData}/accounts.db` regardless and on an ongoing basis: it holds every access token and
every non-owner's study schedule, and it is the one file in the app that cannot be rebuilt from
the canonical files on disk.
