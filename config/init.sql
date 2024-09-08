-- Enable foreign key support
PRAGMA foreign_keys = ON;

-- To store all the tags
CREATE TABLE Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

-- To store the pairs between tags and document ids to make connections on graph view
CREATE TABLE Document_Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES Documents(id),
    FOREIGN KEY (tag_id) REFERENCES Tags(id)
);

CREATE INDEX idx_document_tags ON Document_Tags (document_id, tag_id);

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

-- To store all the flashcards on relation to the documents made
CREATE TABLE Flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    next_recall date,
    front TEXT,
    back TEXT,
    text_renderer_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    highlight_id INTEGER NOT NULL,
    tts_id INTEGER NOT NULL,
    -- New column for TTS voice
    FOREIGN KEY (text_renderer_id) REFERENCES Text_Renderers(id),
    FOREIGN KEY (document_id) REFERENCES Documents(id),
    FOREIGN KEY (highlight_id) REFERENCES Highlight(id),
    FOREIGN KEY (tts_id) REFERENCES TTS_Voices(id) -- Foreign key reference to TTS_Voices table
);

CREATE INDEX idx_flashcards_name ON Flashcards (name);

-- To store the flashcards relative position on relation to the documents on the workspace
CREATE TABLE Highlight (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    Position_text INTEGER,
    Position_pdf INTEGER,
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

-- For pdf based files, to store flashcard relative position on relation to PDF documents
CREATE TABLE Position_pdf (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page INTEGER NOT NULL,
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

-- To store the pairs of ids of flashcards to make connections on graph view
CREATE TABLE Flashcard_Connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_id INTEGER NOT NULL,
    destiny_id INTEGER NOT NULL,
    FOREIGN KEY (origin_id) REFERENCES Flashcards(id),
    FOREIGN KEY (destiny_id) REFERENCES Flashcards(id)
);

CREATE INDEX idx_flashcard_connections ON Flashcard_Connections (origin_id, destiny_id);

-- For pdf based files, to store flashcard relative position to files that store media on text, md, txt or else
CREATE TABLE Position_text (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start INTEGER NOT NULL,
end INTEGER NOT NULL
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

-- To describe inheritance from tags made on documents to tags on flashcards
CREATE TABLE Flashcard_Inherited_Tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flashcard_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (flashcard_id) REFERENCES Flashcards(id),
    FOREIGN KEY (tag_id) REFERENCES Tags(id)
);

CREATE INDEX idx_flashcard_inherited_tags ON Flashcard_Inherited_Tags (flashcard_id, tag_id);

-- To store types of TTS voices
CREATE TABLE TTS_Voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_name TEXT NOT NULL,
    language TEXT NOT NULL,
    gender TEXT NOT NULL
);

CREATE INDEX idx_tts_voices ON TTS_Voices (voice_name, language, gender);