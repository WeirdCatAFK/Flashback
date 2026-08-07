# The Validators Folder

Each module in this folder is executed by `validate.js` before the API starts. This ensures the environment is correctly configured and the data persistence layer is healthy.

## Validation Process

1. **Environment Check**: Determines if the runtime is Electron or Node.js to resolve appropriate data paths.
2. **Configuration Validation**:
   - Checks for the existence of `config.json`.
   - Verifies all required parameters (`port`, `host`, etc.) are present.
   - Automatically generates a default configuration if the file is missing.
3. **Database Integrity & Schema Validation**:
   - Performs a `PRAGMA integrity_check` to ensure the SQLite database is not corrupted.
   - Verifies the existence of all 19 required tables.
   - **Atomic Repair**: If integrity fails or tables are missing, it triggers an atomic transaction to rebuild the schema and populate default pedagogical categories, connection types, and node types.

Each validator returns `true` if the system is operational or has been successfully repaired, and `false` if it cannot recover from a critical failure.

## 4. Canonical Layer (third stage, outside `validate()`)

The `.flashback` sidecars and `_decks/*.json` files carry their own version stamp and are brought up to date by `../UpdateRunner.js` before the API starts serving — see `../updates/UPDATES.md`.

It sits in `main.js` rather than in `validate()` for one reason: it ends in a Seal commit, and Seal is only initialised after `validate()` returns. Keeping `validate()` synchronous also keeps every caller (including ~15 test files) unchanged.

Unlike the two stages above it is **never fatal**. Every read path tolerates a file that has not been updated yet, so a failure logs, leaves `CanonicalVersion` unwritten, and the next launch tries again — a vault is never held hostage to a migration.
