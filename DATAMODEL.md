# Flashback Data Model Specification

The Flashback system maintains data in **two synchronized layers**:

1. **Canonical Data Layer**

   - Stored as `.flashback` files in the user’s file tree.
   - Human-readable JSON format (hidden by default for convenience).
   - Serves as the _source of truth_ for documents, annotations, flashcards, tags, and media references.
   - Designed for portability, packaging, and sharing of study materials.
2. **Derived Data Layer**

   - Stored in a **SQLite database**.
   - Optimized for fast querying and consumption by the Flashback API.
   - Contains normalized and indexed representations of canonical data (flashcards, tags, review logs, presence metrics).

---

## Canonical File Structure

Every project (e.g., a course) is organized in a regular directory tree. Each folder and file may have an associated `.flashback` file storing metadata and flashcard data.

**Example: raw file tree**

```
Inteligencia_Artificial
├── Clase060824.ipynb
├── clase070824.ipynb
├── datasets
│   └── breast_cancer_data.csv

```

**Example: file tree with `.flashback` data**

```
Inteligencia_Artificial
├── .flashback                        # folder-level metadata
├── Clase060824.ipynb
├── Clase060824.ipynb.flashback       # flashcards + metadata for this file
├── clase070824.ipynb
├── clase070824.ipynb.flashback
├── datasets
│   ├── .flashback
│   ├── breast_cancer_data.csv
│   └── breast_cancer_data.csv.flashback

```

### Folder-level `.flashback` file

- Contains metadata and tags inherited by all files and flashcards within the folder.
- Example:

```json
{
  "globalHash": "unique-folder-hash", # A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Artificial Intelligence", "Course", "Fall 2024"],
}

```

### File-level `.flashback` file

- Contains metadata and flashcards for the specific file.
- Example:

```json
{
  "globalHash": "unique-file-hash",# A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Lecture", "KNN"],
  "excludedTags": ["AI"],
  "flashcards": [
    {
    "name": "optional descriptive name",
    "globalHash": "identifier",
    "lastRecall": "2025-09-14T15:30:00Z", # ISO 8601 Format,
    "level" : 6, # Number of consecutive positive recalls,
    "easeFactor": 0.45,
    "presence": 0.57,
      "tags": ["Definition", "Supervised Learning"],
      "category": "Concept",
      "customData": {
        // where editor is a custom object that is interpreted by the frontend to make calls to the api
        // If your flashcard contains any customData it will be interpreted as custom by the api
        "html": "<Front>What is KNN?</img src = editor.media.visualization></Front><Back>K-Nearest Neighbors algorithm</imgsrc = editor.media.neighbor></Back>",
        "media": {"visualization": "./media/visualization.png",
          "neighbor": "./media/neighbor.png"
         }
      },
      "vanillaData": {
        "frontText": "What is KNN?",
        "backText": "K-Nearest Neighbors algorithm",
        "media": {
          "frontImg": "./media/front.png",
          "backImg": "./media/back.png",
          "frontSound": "./media/front.mp3",
          "backSound": "./media/back.mp3"
        }
        "location" :
	        {"type": "pdf_location", "data": {"page": 12, "bbox": [100, 200, 400, 250]}}
      }
    }
  ]
}

```

---

### Reference examples

Reference data varies from the types of documents, so the data might change according to the document. Reference values indicate on which part of the document references the flashcard

- **Text Documents:**
  - `{"type": "text_offset", "data": {"start": 123, "end": 150}}`
    (character offsets; resilient if document is not heavily edited)
- **PDFs:**
  - `{"type": "pdf_location", "data": {"page": 12, "bbox": [100, 200, 400, 250]}}`
    (page number + bounding box of referenced text/area)
- **Videos/Audio:**
  - `{"type": "video_timestamp", "data": {"start": 45.2, "end": 50.8}}`

## Tagging and Categorization

Flashback supports two complementary metadata systems:

1. **Tags**

   - Can be applied at folder, file, or flashcard level.
   - Tags propagate downward (inheritance), creating implicit relationships between items across the tree.
   - This allows cross-cutting connections beyond strict file hierarchy (e.g., two unrelated flashcards both tagged `"Linear Algebra"`).
2. **Categories**

   - Define the pedagogical role of a flashcard.
   - Default categories, grouped by priority:
     | Priority | Category        | Description                                    |
     | -------- | --------------- | ---------------------------------------------- |
     | 0        | `Definition`  | The definition of a word or concept            |
     | 0        | `Terminology` | The usage of a word                            |
     | 0        | `Symbol`      | The usage of symbols                           |
     | 1        | `Concept`     | An abstract idea                               |
     | 1        | `Example`     | Examples of usage                              |
     | 2        | `Exercise`    | Apply knowledge in a practical task or problem |
     | 2        | `Procedure`   | Execute a method or algorithm step by step     |
   - Lower priority number = reviewed first. Categories are seeded at startup via `DefaultData.js`.

---

## Media Organization

- Each folder maintains its own media directory, scoped to that folder’s `.flashback` and flashcards. Markdown and html documents may access this folder to reference media files, but the scope of the support it's only trough the flasback frontend
- Each flashback directory is meant for self-contained packaging is meant to translate folder data structures to courses for sharing
- Example layout:

```
Inteligencia_Artificial
├── .flashback
├── Clase060824.ipynb
├── Clase060824.ipynb.flashback
├── media
│   ├── front.png
│   ├── back.png
│   └── sound.mp3

```

## Access Module Hierarchy

All data operations flow through `src/api/access/`. Modules are organised in three tiers — lower tiers have no knowledge of anything above them.

```
Tier 1 — Primitives
  config.js     Resolves the config path and owns config.json I/O (cached singleton).
  database.js   Opens dreams.db and exports the better-sqlite3 connection singleton.

Tier 2 — Single-resource access
  query.js      All parameterised SQL statements. The only layer allowed to call db.prepare().
  files.js      All filesystem operations. The only layer allowed to read/write .flashback sidecars.

Tier 3 — Orchestration
  srs.js          Coordinates review submissions: updates Flashcards and inserts ReviewLogs in one transaction.
  documents.js    Main orchestrator. Coordinates files + query + srs to keep both layers in sync.
  subscriptions.js Coordinates issue import/merge on top of documents.
```

**Rules that keep this stable long-term:**

- `query.js` and `files.js` never import each other.
- `srs.js` and `documents.js` never import each other.
- `subscriptions.js` is the only module allowed to import `documents.js`.
- Raw `db.prepare()` calls outside `query.js` are not allowed.
- Filesystem access outside `files.js` is not allowed (except temp-dir work in orchestrators).

---

## Seal — Workspace Versioning

Seal is a git-backed versioning layer that sits alongside the access hierarchy in `src/api/seal/`. It is a self-contained subsystem with its own internal separation of concerns.

### Purpose

Every write operation through `Documents.js` produces an atomic git commit in the workspace git repository (`workspaceRoot`). This gives Flashback a full history of the canonical layer — user documents, `.flashback` sidecars, and media — without requiring git to be installed on the host machine (uses [isomorphic-git](https://isomorphic-git.org/)).

### Repository Layout

The Seal git repository is initialised at `workspaceRoot` on startup by `sealTools.init()` (called from `main.js` after validation). The database and config files live outside `workspaceRoot` and are never tracked.

```
data/
├── dreams.db        ← derived layer, not tracked
├── config.json      ← not tracked
└── workspace/       ← git repo root (sealTools.init here)
    ├── .git/
    ├── .flashback
    ├── MyFolder/
    │   ├── .flashback
    │   ├── note.md
    │   └── note.md.flashback
    └── ...
```

### Internal Structure

```
src/api/seal/
  seal.js
    SealEventEmitter   Primitive. No database knowledge. Stages files and commits
                       after each Documents.js write. One commit per operation.
    SealTools          Orchestrator. Imports query.js to coordinate git operations
                       with database state (rollback SRS handling, inspect reconciliation).
```

`SealTools` is the only component in the Seal subsystem allowed to import `query.js`.

### Commit Format

Each commit message follows the pattern `<action>: <sidecar-path>`:

| Action                             | Trigger                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `create: path/file.md.flashback` | `createFile`, `createFolder`, `importFile`                              |
| `edit: path/file.md.flashback`   | `updateFile`, `updateMetadata`, `submitReview`, `addMediaToFlashcard` |
| `move: old/path -> new/path`     | `rename`, `move`                                                          |
| `delete: path/file.md.flashback` | `delete`                                                                    |

For folder operations, all contained file and sidecar paths are staged in the same commit so each commit represents one atomic user action.

### Rollback and SRS State

SRS progress (`level`, `ease_factor`, `last_recall`) lives in the database and is not embedded in git history. Rolling back the canonical layer therefore presents a conflict between content state and review progress. `SealTools.rollback(ref, keepSrsProgress)` handles this:

- **`keepSrsProgress: true` (default)** — snapshots all current SRS state (keyed by `global_hash`) before checkout. After checkout the snapshot is re-applied in a single transaction via `query.batchRestoreFlashcardSrsState()`. Cards that no longer exist in the rolled-back layer are silently dropped.
- **`keepSrsProgress: false`** — SRS reverts with the content. The sidecars carry a point-in-time snapshot of SRS state from when the commit was made, which becomes the new source of truth.

In both cases the caller must rebuild the derived layer from the rolled-back sidecars before the app is usable again (via `sealTools.inspect()` and reconciliation).

### Out-of-band Change Detection

`sealTools.inspect()` diffs HEAD against the current workdir using `git.statusMatrix` and returns:

```js
{ added: string[], modified: string[], deleted: string[] }
```

Only `.flashback` sidecar paths are returned — the caller (a route or startup check) is responsible for reconciling each category against the derived layer:

- **added** — import the new sidecar into the database
- **modified** — re-sync the sidecar's flashcards and metadata
- **deleted** — remove the corresponding document or folder from the database

---

# Derived data model

Derived data for faster optimized querying.
The Flashback schema is organized around the **Flashcard** as the atomic unit of knowledge.Supporting entities capture content, references, pedagogical context, relationships, and user review history.

- **Flashcards**

  - Core unit of memory representation.
  - Links to `FlashcardContent` (text, media), optional `FlashcardReference` (position in document), and `PedagogicalCategories`.
  - Connected to the knowledge graph via a `node_id` (in `Nodes`).
  - Trackable attributes like `last_recall`, `name`, and `presence`.
- **FlashcardContent**

  - Stores the actual front/back text, media (images, sounds), and optional rendered/custom HTML.
- **FlashcardReference**

  - Anchors a flashcard to a document position, page, or bounding box.
  - Allows spatial or positional memory association.
- **Documents** and **Folders**

  - Hierarchical organization of knowledge sources.
  - Each has a `node_id` for integration into the graph.
  - Both can carry a `presence` metric for measuring familiarity.
- **PedagogicalCategories**

  - Defines priority for reviewing flashcards (e.g., definitions before concepts).
- **Tags**

  - Labels to organize and cluster concepts.
  - Tags inherit through `Connections` using `InheritedTags`.
- **Connections** and **ConnectionTypes**

  - Define graph edges between `Nodes`.
  - `is_directed` marks whether the relationship has directionality.
- **Nodes** and **NodeTypes**

  - Universal graph nodes that can represent flashcards, documents, tags, or categories.
  - Provide flexible abstraction for connections.
- **Media**

  - Repository of static assets (images, audio, etc.), retrievable by `hash` or `name`.
- **ReviewLogs**

  - Tracks spaced repetition history per flashcard.
  - Includes `timestamp`, `outcome`, `ease_factor`, and `level` for performance analysis.
- **Subscriptions**

  - Tracks magazine/course subscriptions. One row per `magazine_id`.
  - Stores the current `issue_id`, `version`, `target_path` (where in the workspace the content lives), and `last_sync` timestamp.
  - Updated on each `importIssue()` call by `Subscriptions.js`.

---

## Data Dictionary

### Table: Flashcards

| Column       | Type         | Description                                                          |
| ------------ | ------------ | -------------------------------------------------------------------- |
| id           | integer (PK) | Unique identifier for each flashcard.                                |
| global_hash  | varchar(500) | Global hash for deduplication and synchronization.                   |
| node_id      | integer (FK) | Links flashcard into the knowledge graph.                            |
| document_id  | integer (FK) | References the source document, if any.**(ON DELETE CASCADE)** |
| category_id  | integer (FK) | Pedagogical category (e.g., definition, concept).                    |
| content_id   | integer (FK) | Points to the flashcard’s content (front/back).                     |
| reference_id | integer (FK) | Anchors flashcard to a document position.                            |
| last_recall  | timestamp    | Last time the flashcard was recalled.                                |
| name         | varchar(500) | Optional descriptive name of the flashcard.                          |
| origin       | varchar(500) | Source identifier (e.g., subscription magazine_id).                  |
| presence     | float        | Familiarity/strength metric (derived from reviews).                  |
| level        | integer      | Number of consecutive positive recalls.                              |
| fileIndex    | integer      | Position of the flashcard within its source file.                    |

---

### Table: FlashcardContent

| Column      | Type         | Description                               |
| ----------- | ------------ | ----------------------------------------- |
| id          | integer (PK) | Unique identifier for content.            |
| custom_html | text         | User-provided HTML formatting.            |
| render_html | text         | Processed HTML for display.               |
| frontText   | varchar(500) | Text shown on the front of the flashcard. |
| backText    | varchar(500) | Text shown on the back of the flashcard.  |
| front_img   | varchar(500) | Path/URL of image for front side.         |
| back_img    | varchar(500) | Path/URL of image for back side.          |
| front_sound | varchar(500) | Path/URL of audio for front side.         |
| back_sound  | varchar(500) | Path/URL of audio for back side.          |

---

### Table: FlashcardReference

| Column | Type         | Description                                               |
| ------ | ------------ | --------------------------------------------------------- |
| id     | integer (PK) | Unique identifier for reference.                          |
| type   | varchar(500) | Type of reference (text, pdf, video, etc.).               |
| start  | float        | Start offset (time, character, etc.).                     |
| end    | float        | End offset.                                               |
| page   | integer      | Page number if applicable.                                |
| bbox   | json         | Bounding box for precise anchoring (x, y, width, height). |

---

### Table: Documents

| Column        | Type         | Description                                         |
| ------------- | ------------ | --------------------------------------------------- |
| id            | integer (PK) | Unique document identifier.                         |
| folder_id     | integer (FK) | Parent folder.**(ON DELETE CASCADE)**         |
| node_id       | integer (FK) | Integration into graph.                             |
| global_hash   | varchar(500) | Hash for deduplication/sync.                        |
| relative_path | varchar(500) | Relative path to file.                              |
| absolute_path | varchar(500) | Absolute path to file.                              |
| name          | varchar(500) | Display name of the document.                       |
| origin        | varchar(500) | Source identifier (e.g., subscription magazine_id). |
| encoding      | varchar(20)  | Detected character encoding of the file.            |
| presence      | float        | Familiarity/usage score.                            |

---

### Table: Folders

| Column        | Type         | Description                                                  |
| ------------- | ------------ | ------------------------------------------------------------ |
| id            | integer (PK) | Unique folder identifier.                                    |
| global_hash   | varchar(500) | Hash for deduplication.                                      |
| node_id       | integer (FK) | Integration into graph.                                      |
| parent_id     | integer (FK) | Parent folder.**(ON DELETE CASCADE, nullable = root)** |
| relative_path | varchar(500) | Relative path to folder.                                     |
| absolute_path | varchar(500) | Absolute path to folder.                                     |
| name          | varchar(500) | Folder name.                                                 |
| origin        | varchar(500) | Source identifier (e.g., subscription magazine_id).          |
| presence      | float        | Familiarity/usage score.                                     |

---

### Table: PedagogicalCategories

| Column      | Type         | Description                                            |
| ----------- | ------------ | ------------------------------------------------------ |
| id          | integer (PK) | Unique identifier.                                     |
| name        | varchar(500) | Category name (definition, concept, relation, etc.).   |
| priority    | integer      | Priority for review ordering (lower = reviewed first). |
| description | text         | Human-readable description of the category.            |

---

### Table: Tags

| Column   | Type         | Description                                          |
| -------- | ------------ | ---------------------------------------------------- |
| id       | integer (PK) | Unique identifier.                                   |
| name     | varchar(500) | Tag label.                                           |
| node_id  | integer (FK) | Integration into graph.**(ON DELETE CASCADE)** |
| origin   | varchar(500) | Source identifier (e.g., subscription magazine_id).  |
| presence | float        | Familiarity/usage score.                             |

---

### Table: Connections

| Column     | Type         | Description                               |
| ---------- | ------------ | ----------------------------------------- |
| id         | integer (PK) | Unique identifier for connection.         |
| origin_id  | integer (FK) | Source node.**(ON DELETE CASCADE)** |
| destiny_id | integer (FK) | Target node.**(ON DELETE CASCADE)** |
| type_id    | integer (FK) | Type of connection.                       |

---

### Table: Nodes

| Column  | Type         | Description                   |
| ------- | ------------ | ----------------------------- |
| id      | integer (PK) | Unique identifier.            |
| type_id | integer (FK) | Type of node (see NodeTypes). |

---

### Table: Media

| Column        | Type         | Description                       |
| ------------- | ------------ | --------------------------------- |
| id            | integer (PK) | Unique identifier.                |
| hash          | varchar(500) | Hash for deduplication/retrieval. |
| name          | varchar(500) | Media name.                       |
| relative_path | varchar(500) | Relative path.                    |
| absolute_path | varchar(500) | Absolute path.                    |

---

### Table: NodeTypes

| Column | Type         | Description                                                 |
| ------ | ------------ | ----------------------------------------------------------- |
| id     | integer (PK) | Unique identifier.                                          |
| name   | varchar(500) | Name of node type (flashcard, document, folder, tag, etc.). |

---

### Table: ConnectionTypes

| Column      | Type         | Description                                             |
| ----------- | ------------ | ------------------------------------------------------- |
| id          | integer (PK) | Unique identifier.                                      |
| name        | varchar(500) | Type of connection (default: disconnection, inherited). |
| is_directed | integer      | Whether the edge is directional (1 = true, 0 = false).  |

---

### Table: InheritedTags

| Column        | Type         | Description                                                   |
| ------------- | ------------ | ------------------------------------------------------------- |
| id            | integer (PK) | Unique identifier.                                            |
| connection_id | integer (FK) | Connection carrying the tag.**(ON DELETE CASCADE)**     |
| tag_id        | integer (FK) | Tag applied through inheritance.**(ON DELETE CASCADE)** |

---

### Table: ReviewLogs

| Column       | Type         | Description                                      |
| ------------ | ------------ | ------------------------------------------------ |
| id           | integer (PK) | Unique identifier.                               |
| flashcard_id | integer (FK) | Reviewed flashcard.**(ON DELETE CASCADE)** |
| timestamp    | timestamp    | When the review occurred.                        |
| outcome      | integer      | Result of recall (e.g., success, failure).       |
| ease_factor  | float        | Spaced repetition ease factor.                   |
| level        | integer      | Current level/stage in SRS algorithm.            |

---

### Table: Subscriptions

| Column      | Type         | Description                                              |
| ----------- | ------------ | -------------------------------------------------------- |
| id          | integer (PK) | Unique identifier.                                       |
| magazine_id | varchar(500) | Unique identifier for the subscription source.           |
| issue_id    | varchar(500) | Identifier of the last imported issue.                   |
| version     | varchar(100) | Version string of the last imported issue.               |
| target_path | varchar(500) | Relative workspace path where the content was installed. |
| last_sync   | timestamp    | Timestamp of the last successful import.                 |
