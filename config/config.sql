-- Enable foreign key support
PRAGMA foreign_keys = ON;

-- To store which method I'll use to play the media
CREATE TABLE Media_Types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

-- To store the file extension of documents and media
CREATE TABLE File_Extensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type_id INTEGER NOT NULL,
    extension TEXT NOT NULL,
    FOREIGN KEY (media_type_id) REFERENCES Media_Types(id)
);

-- To store if a tag will be hereditary or not (and any other type that occurs to me)
CREATE TABLE Tag_Types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

-- To store all the tags
CREATE TABLE Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag_type_id INTEGER NOT NULL,
    FOREIGN KEY (tag_type_id) REFERENCES Tag_Types(id)
);

-- To store all the documents on the scope of the project (will be relevant later for graph view)
CREATE TABLE Documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    media_type_id INTEGER NOT NULL,
    FOREIGN KEY (media_type_id) REFERENCES File_Extensions(id)
);

-- To store all the flashcards on relation to the documents made
CREATE TABLE Flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    name TEXT,
    text_renderer_id INTEGER NOT NULL,
    front TEXT,
    back TEXT,
    FOREIGN KEY (document_id) REFERENCES Documents(id),
    FOREIGN KEY (text_renderer_id) REFERENCES Text_Renderers(id)
);

-- To choose markdown flavor or plain text
CREATE TABLE Text_Renderers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL
);

-- To store the pairs of ids of flashcards to make connections on graph view
CREATE TABLE Flashcard_Connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_id INTEGER NOT NULL,
    destiny_id INTEGER NOT NULL,
    FOREIGN KEY (origin_id) REFERENCES Flashcards(id),
    FOREIGN KEY (destiny_id) REFERENCES Flashcards(id)
);

-- To store the pairs of ids of Documents to make connections on graph view
CREATE TABLE Document_Connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_id INTEGER NOT NULL,
    destiny_id INTEGER NOT NULL,
    FOREIGN KEY (origin_id) REFERENCES Documents(id),
    FOREIGN KEY (destiny_id) REFERENCES Documents(id)
);

-- To store the pairs between tags and document ids to make connections on graph view
CREATE TABLE Document_Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES Documents(id),
    FOREIGN KEY (tag_id) REFERENCES Tags(id)
);

-- To store pairs between tags and flashcard ids to make connections on graph view
CREATE TABLE Flashcard_Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flashcard_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (flashcard_id) REFERENCES Flashcards(id),
    FOREIGN KEY (tag_id) REFERENCES Tags(id)
);

-- To access the media that may be contained in the flashcards
CREATE TABLE Flashcard_Media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flashcard_id INTEGER NOT NULL,
    media_type_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    FOREIGN KEY (flashcard_id) REFERENCES Flashcards(id),
    FOREIGN KEY (media_type_id) REFERENCES Media_Types(id)
);

-- Create indexes separately
CREATE INDEX idx_flashcards_name ON Flashcards(name);

CREATE INDEX idx_flashcard_connections ON Flashcard_Connections(origin_id, destiny_id);

CREATE INDEX idx_document_connections ON Document_Connections(origin_id, destiny_id);

CREATE INDEX idx_document_tags ON Document_Tags(document_id, tag_id);

CREATE INDEX idx_flashcard_tags ON Flashcard_Tags(flashcard_id, tag_id);

CREATE INDEX idx_flashcard_media ON Flashcard_Media(flashcard_id, media_type_id);