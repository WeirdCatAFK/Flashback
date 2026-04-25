# Flashback Access Layer

The Access layer is the core of the Flashback system, responsible for maintaining the relationship between the file system and the database. 

**CRITICAL**: All data modifications must be performed through these modules to maintain synchronization between the Canonical and Derived data layers. For structural details, consult the [Data Model Specification](../../../DATAMODEL.md).

## Core Modules

### 1. `Documents` (The Orchestrator)
The central bridge of the system. It ensures that any change in the file system (adding a document, moving a folder) is reflected in the database. 
- Manages high-level operations: `import`, `export`, `move`, and `rename`.
- Handles the synchronization of flashcards and metadata.
- Implements the Spaced Repetition System (SRS) review logic.

### 2. `Files` (Canonical System)
Handles all direct interactions with the user's workspace on the disk.
- Manages `.flashback` sidecar files (metadata and flashcards).
- Ensures safe path resolution within the workspace root.
- Handles reading and writing of file content and its associated hidden metadata.

### 3. `Database` (Derived System)
Provides the connection and configuration for the **SQLite** database.
- Uses `better-sqlite3` for high-performance indexing.
- Implements Write-Ahead Logging (WAL) for safe concurrent access.

### 4. `Media`
Dedicated handler for binary assets (images, audio) referenced by flashcards.
- Ensures media is correctly scoped to its parent folder.
- Manages the persistence of media metadata in the database.
