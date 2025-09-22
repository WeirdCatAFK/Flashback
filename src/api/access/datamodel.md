

# Flashback Data Model Specification

The Flashback system maintains data in **two synchronized layers**:

1.  **Canonical Data Layer**
    
    -   Stored as `.flashback` files in the user’s file tree.
        
    -   Human-readable JSON format (hidden by default for convenience).
        
    -   Serves as the _source of truth_ for documents, annotations, flashcards, tags, and media references.
        
    -   Designed for portability, packaging, and sharing of study materials.
        
2.  **Derived Data Layer**
    
    -   Stored in a **SQLite database**.
        
    -   Optimized for fast querying and consumption by the Flashback API.
        
    -   Contains normalized and indexed representations of canonical data (flashcards, tags, review logs, presence metrics).
        

----------

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

-   Contains metadata and tags inherited by all files and flashcards within the folder.
    
-   Example:
    

```json
{
  "globalId": "unique-folder-hash", # A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Artificial Intelligence", "Course", "Fall 2024"],
}

```

### File-level `.flashback` file

-   Contains metadata and flashcards for the specific file.
    
-   Example:
    
```json
{
  "globalId": "unique-file-hash",# A hash that is defined by the creator and the timestamp of when it was created
  "tags": ["Lecture", "KNN"],
  "excludedTags": ["AI"],
  "flashcards": [
    {
    "lastRecall": "2025-09-14T15:30:00Z", # ISO 8601 Format,
    "level" : 6, # Number of consecutive positive recalls
      "tags": ["Definition", "Supervised Learning"],
      "categories": ["Concept"],
      "isCustom": true,
      "isVanilla": false,
      "customData": {
        "html": "<Front>What is KNN?</Front><Back>K-Nearest Neighbors algorithm</Back>"
      },
      "vanillaData": {
        "frontText": "What is KNN?",
        "backText": "K-Nearest Neighbors algorithm",
        "media": {
          "front_img": "./media/front.png",
          "back_img": "./media/back.png",
          "front_sound": "./media/front.mp3",
          "back_sound": "./media/back.mp3"
        }
        "location" :
	        {"type": "pdf_location", "data": {"page": 12, "bbox": [100, 200, 400, 250]}}
      }
    }
  ]
}

```

----------
### Reference examples
Reference data varies from the types of documents, so the data might change according to the document. Reference values indicate on which part of the document references the flashcard
-   **Text Documents:**
    -   `{"type": "text_offset", "data": {"start": 123, "end": 150}}`  
        (character offsets; resilient if document is not heavily edited)
-   **PDFs:**
    -   `{"type": "pdf_location", "data": {"page": 12, "bbox": [100, 200, 400, 250]}}`  
        (page number + bounding box of referenced text/area)
-   **Videos/Audio:**
    -   `{"type": "video_timestamp", "data": {"start": 45.2, "end": 50.8}}`  
## Tagging and Categorization

Flashback supports two complementary metadata systems:

1.  **Tags**
    
    -   Can be applied at folder, file, or flashcard level.
        
    -   Tags propagate downward (inheritance), creating implicit relationships between items across the tree.
        
    -   This allows cross-cutting connections beyond strict file hierarchy (e.g., two unrelated flashcards both tagged `"Linear Algebra"`).
        
2.  **Categories**
    
    -   Define the pedagogical role of a flashcard.
        
    -   Default categories are:
        
        -   `"Definition"` → basic terminology
            
        -   `"Concept"` → abstract ideas
            
        -   `"Question"` → applied recall
            
        -   `"Exercise"` → problem-solving
            
    -   Categories are hierarchical, supporting progression from simple to complex learning stages.
        
    -   The system may allow custom extension or reordering of categories per project.
        

----------

## Media Organization

-   Each folder maintains its own media directory, scoped to that folder’s `.flashback` and flashcards. Markdown and html documents may access this folder to reference media files, but the scope of the support it's only trough the flasback frontend
    
-   Each flashback directory is meant for self-contained packaging is meant to translate folder data structures to courses for sharing
    
-   Example layout:
    

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

# Derived data model
Derived data for faster optimized querying.
The Flashback schema is organized around the **Flashcard** as the atomic unit of knowledge.  
Supporting entities capture content, references, pedagogical context, relationships, and user review history.  

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

---

## Data Dictionary

### Table: Flashcards
| Column       | Type         | Description |
|--------------|-------------|-------------|
| id           | integer (PK) | Unique identifier for each flashcard. |
| global_hash  | varchar(500) | Global hash for deduplication and synchronization. |
| node_id      | integer (FK) | Links flashcard into the knowledge graph. |
| document_id  | integer (FK) | References the source document, if any. |
| category_id  | integer (FK) | Pedagogical category (e.g., definition, concept). |
| content_id   | integer (FK) | Points to the flashcard’s content (front/back). |
| reference_id | integer (FK) | Anchors flashcard to a document position. |
| last_recall  | timestamp    | Last time the flashcard was recalled. |
| name         | varchar(500) | Optional descriptive name of the flashcard. |
| presence     | float        | Familiarity/strength metric (derived from reviews). |

---

### Table: FlashcardContent
| Column      | Type         | Description |
|-------------|-------------|-------------|
| id          | integer (PK) | Unique identifier for content. |
| custom_html | text         | User-provided HTML formatting. |
| render_html | text         | Processed HTML for display. |
| frontText   | varchar(500) | Text shown on the front of the flashcard. |
| backText    | varchar(500) | Text shown on the back of the flashcard. |
| front_img   | varchar(500) | Path/URL of image for front side. |
| back_img    | varchar(500) | Path/URL of image for back side. |
| front_sound | varchar(500) | Path/URL of audio for front side. |
| back_sound  | varchar(500) | Path/URL of audio for back side. |

---

### Table: FlashcardReference
| Column | Type         | Description |
|--------|-------------|-------------|
| id     | integer (PK) | Unique identifier for reference. |
| type   | varchar(500) | Type of reference (text, pdf, video, etc.). |
| start  | float        | Start offset (time, character, etc.). |
| end    | float        | End offset. |
| page   | integer      | Page number if applicable. |
| bbox   | json         | Bounding box for precise anchoring (x, y, width, height). |

---

### Table: Documents
| Column        | Type         | Description |
|---------------|-------------|-------------|
| id            | integer (PK) | Unique document identifier. |
| folder_id     | integer (FK) | Parent folder. |
| node_id       | integer (FK) | Integration into graph. |
| global_hash   | varchar(500) | Hash for deduplication/sync. |
| relative_path | varchar(500) | Relative path to file. |
| absolute_path | varchar(500) | Absolute path to file. |
| name          | varchar(500) | Display name of the document. |
| presence      | float        | Familiarity/usage score. |

---

### Table: Folders
| Column        | Type         | Description |
|---------------|-------------|-------------|
| id            | integer (PK) | Unique folder identifier. |
| global_hash   | varchar(500) | Hash for deduplication. |
| node_id       | integer (FK) | Integration into graph. |
| relative_path | varchar(500) | Relative path to folder. |
| absolute_path | varchar(500) | Absolute path to folder. |
| name          | varchar(500) | Folder name. |
| presence      | float        | Familiarity/usage score. |

---

### Table: PedagogicalCategories
| Column  | Type         | Description |
|---------|-------------|-------------|
| id      | integer (PK) | Unique identifier. |
| name    | varchar(500) | Category name (definition, concept, relation, etc.). |
| priority| integer      | Priority for review ordering. |
| node_id | integer (FK) | Integration into graph. |

---

### Table: Tags
| Column  | Type         | Description |
|---------|-------------|-------------|
| id      | integer (PK) | Unique identifier. |
| name    | varchar(500) | Tag label. |
| node_id | integer (FK) | Integration into graph. |
| presence| float        | Familiarity/usage score. |

---

### Table: Connections
| Column    | Type         | Description |
|-----------|-------------|-------------|
| id        | integer (PK) | Unique identifier for connection. |
| origin_id | integer (FK) | Source node. |
| destiny_id| integer (FK) | Target node. |
| type_id   | integer (FK) | Type of connection. |

---

### Table: Nodes
| Column  | Type         | Description |
|---------|-------------|-------------|
| id      | integer (PK) | Unique identifier. |
| type_id | integer (FK) | Type of node (see NodeTypes). |

---

### Table: Media
| Column        | Type         | Description |
|---------------|-------------|-------------|
| id            | integer (PK) | Unique identifier. |
| hash          | varchar(500) | Hash for deduplication/retrieval. |
| name          | varchar(500) | Media name. |
| relative_path | varchar(500) | Relative path. |
| absolute_path | varchar(500) | Absolute path. |

---

### Table: NodeTypes
| Column | Type         | Description |
|--------|-------------|-------------|
| id     | integer (PK) | Unique identifier. |
| name   | varchar(500) | Name of node type (flashcard, document, folder, tag, etc.). |

---

### Table: ConnectionTypes
| Column     | Type         | Description |
|------------|-------------|-------------|
| id         | integer (PK) | Unique identifier. |
| name       | varchar(500) | Type of connection (default: disconnection, inherited). |
| is_directed| boolean      | Whether the edge is directional. |

---

### Table: InheritedTags
| Column       | Type         | Description |
|--------------|-------------|-------------|
| id           | integer (PK) | Unique identifier. |
| connection_id| integer (FK) | Connection carrying the tag. |
| tag_id       | integer (FK) | Tag applied through inheritance. |

---

### Table: ReviewLogs
| Column      | Type         | Description |
|-------------|-------------|-------------|
| id          | integer (PK) | Unique identifier. |
| flashcard_id| integer (FK) | Reviewed flashcard. |
| timestamp   | timestamp    | When the review occurred. |
| outcome     | integer      | Result of recall (e.g., success, failure). |
| ease_factor | float        | Spaced repetition ease factor. |
| level       | integer      | Current level/stage in SRS algorithm. |

---

