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
   - Verifies the existence of all 14 required tables.
   - **Atomic Repair**: If integrity fails or tables are missing, it triggers an atomic transaction to rebuild the schema and populate default pedagogical categories, connection types, and node types.

Each validator returns `true` if the system is operational or has been successfully repaired, and `false` if it cannot recover from a critical failure.
