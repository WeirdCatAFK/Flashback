-- Enable foreign key support
PRAGMA foreign_keys = ON;

-- To store the pairs between tags and document ids to make connections on graph view
CREATE TABLE Document_Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES Documents(id),
    FOREIGN KEY (tag_id) REFERENCES Tags(id)
);

CREATE INDEX idx_document_tags ON Document_Tags (document_id, tag_id);

--To store all the tags
CREATE TABLE Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag_type_id INTEGER NOT NULL,
    FOREIGN KEY (tag_type_id) REFERENCES Tag_Types(id)
);

-- To store which method used to play the media
CREATE TABLE Media_Types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

-- To store the pairs of ids of Documents to make connections on graph view
CREATE TABLE Document_Connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_id INTEGER NOT NULL,
    destiny_id INTEGER NOT NULL,
    FOREIGN KEY (origin_id) REFERENCES Documents(id),
    FOREIGN KEY (destiny_id) REFERENCES Documents(id)
);

CREATE INDEX idx_document_connections ON Document_Connections (origin_id, destiny_id);

-- To store pairs between tags and flashcard ids to make connections on graph view
CREATE TABLE Flashcard_Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flashcard_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (flashcard_id) REFERENCES Flashcards(id),
    FOREIGN KEY (tag_id) REFERENCES Tags(id)
);

CREATE INDEX idx_flashcard_tags ON Flashcard_Tags (flashcard_id, tag_id);

-- To store all the flashcards on relation to the documents made
CREATE TABLE Flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    front TEXT,
    back TEXT,
    text_renderer_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    highlight_id BIGINT NOT NULL,
    FOREIGN KEY (text_renderer_id) REFERENCES Text_Renderers(id),
    FOREIGN KEY (document_id) REFERENCES Documents(id),
    FOREIGN KEY (highlight_id) REFERENCES Highlight(id)
);

CREATE INDEX idx_flashcards_name ON Flashcards (name);

--To store the flashcards relative position on relation to the documents on the workspace
CREATE TABLE Highlight (
    id BIGINT UNSIGNED PRIMARY KEY AUTOINCREMENT,
    Position_text BIGINT,
    Position_pdf BIGINT,
    FOREIGN KEY (Position_text) REFERENCES Position_text(id),
    FOREIGN KEY (Position_pdf) REFERENCES Position_pdf(id)
);

-- To store the file extension of documents and media
CREATE TABLE File_Extensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type_id INTEGER NOT NULL,
    extension TEXT NOT NULL,
    FOREIGN KEY (media_type_id) REFERENCES Media_Types(id)
);

--For pdf based files, to store flashcard relative position on relation to PDF documents
CREATE TABLE Position_pdf (
    id BIGINT UNSIGNED PRIMARY KEY AUTOINCREMENT,
    page BIGINT NOT NULL,
    x FLOAT NOT NULL,
    y FLOAT NOT NULL
);

CREATE INDEX idx_position_pdf ON Position_pdf (page, x, y);

-- To choose markdown flavor or plain text
CREATE TABLE Text_Renderers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL
);

-- To store all the documents on the scope of the project (will be relevant later for graph view)
CREATE TABLE Documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    media_type_id INTEGER NOT NULL,
    FOREIGN KEY (media_type_id) REFERENCES Media_Types(id)
);

-- To store if a tag will be hereditary or not (and any other type that occurs to me)
CREATE TABLE Tag_Types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

-- To store the pairs of ids of flashcards to make connections on graph view
CREATE TABLE Flashcard_Connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_id INTEGER NOT NULL,
    destiny_id INTEGER NOT NULL,
    FOREIGN KEY (origin_id) REFERENCES Flashcards(id),
    FOREIGN KEY (destiny_id) REFERENCES Flashcards(id)
);

CREATE INDEX idx_flashcard_connections ON Flashcard_Connections (origin_id, destiny_id);

--For pdf based files, to store flashcard relative position to files that store media on text, md, txt or else
CREATE TABLE Position_text (
    id BIGINT UNSIGNED PRIMARY KEY AUTOINCREMENT,
    start BIGINT NOT NULL,
end BIGINT NOT NULL
);

CREATE INDEX idx_position_text ON Position_text (start,end
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

CREATE INDEX idx_flashcard_media ON Flashcard_Media (flashcard_id, media_type_id);