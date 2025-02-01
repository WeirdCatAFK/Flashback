const integrity_sql = `SELECT COUNT(*) FROM sqlite_master 
WHERE type = 'table' 
  AND name IN (
    'Node_types', 'Nodes', 'Folders', 'Documents', 'Flashcard_highlight', 
    'Flashcards', 'Flashcard_info', 'Media_types', 'Media', 'Flashcard_media', 
    'Tags', 'Connection_types', 'Node_connections', 'Inherited_tags', 'Path', 
    'Path_connections'
  );`;

const init_sql = `
PRAGMA foreign_keys = OFF;

-- Node Types
CREATE TABLE IF NOT EXISTS Node_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR
);

-- Media Types
CREATE TABLE IF NOT EXISTS Media_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name INTEGER,
  file_extension VARCHAR
);

-- Connection Types
CREATE TABLE IF NOT EXISTS Connection_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR
);

-- Path
CREATE TABLE IF NOT EXISTS Path (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR
);

-- Nodes
CREATE TABLE IF NOT EXISTS Nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER,
  presence FLOAT,
  FOREIGN KEY (type_id) REFERENCES Node_types(id)
);

CREATE INDEX idx_node_presence ON Nodes (presence);

-- Folders
CREATE TABLE IF NOT EXISTS Folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR,
  filepath VARCHAR,
  node_id INTEGER,
  parent_folder_id INTEGER,
  FOREIGN KEY (node_id) REFERENCES Nodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_folder_path_retrieval ON Folders (filepath);

CREATE INDEX idx_folder_name_retrieval ON Folders (name);

-- Documents
CREATE TABLE IF NOT EXISTS Documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER,
  name VARCHAR,
  filepath VARCHAR,
  file_extension VARCHAR,
  node_id INTEGER,
  FOREIGN KEY (folder_id) REFERENCES Folders(id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES Nodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_doc_name_search ON Documents (name);

-- Flashcard Highlights
CREATE TABLE IF NOT EXISTS Flashcard_highlight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page INTEGER,
  x1 FLOAT,
  y1 FLOAT,
  x2 FLOAT,
  y2 FLOAT,
  start INTEGER,
end INTEGER
);

-- Flashcards
CREATE TABLE IF NOT EXISTS Flashcards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER,
  node_id INTEGER,
  highlight_id INTEGER,
  name VARCHAR,
  front TEXT,
  back TEXT,
  next_recall DATETIME,
  FOREIGN KEY (document_id) REFERENCES Documents(id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES Nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (highlight_id) REFERENCES Flashcard_highlight(id) ON DELETE
  SET
    NULL
);

CREATE INDEX idx_document ON Flashcards (document_id);

CREATE INDEX idx_highlight ON Flashcards (highlight_id);

CREATE INDEX idx_flashcard_name_search ON Flashcards (name);

-- Flashcard Info
CREATE TABLE IF NOT EXISTS Flashcard_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flashcard_id INTEGER,
  text_renderer VARCHAR,
  tts_voice VARCHAR,
  FOREIGN KEY (flashcard_id) REFERENCES Flashcards(id) ON DELETE CASCADE
);

-- Media
CREATE TABLE IF NOT EXISTS Media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media BLOB,
  media_type_id INTEGER,
  FOREIGN KEY (media_type_id) REFERENCES Media_types(id)
);

-- Flashcard Media
CREATE TABLE IF NOT EXISTS Flashcard_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flashcard_id INTEGER,
  front_media_id INTEGER,
  back_media_id INTEGER,
  FOREIGN KEY (flashcard_id) REFERENCES Flashcards(id) ON DELETE CASCADE,
  FOREIGN KEY (front_media_id) REFERENCES Media(id) ON DELETE
  SET
    NULL,
    FOREIGN KEY (back_media_id) REFERENCES Media(id) ON DELETE
  SET
    NULL
);

-- Tags
CREATE TABLE IF NOT EXISTS Tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR,
  FOREIGN KEY (id) REFERENCES Nodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_tag_name_retrieval ON Tags (name);

-- Node Connections
CREATE TABLE IF NOT EXISTS Node_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_id INTEGER,
  destiny_id INTEGER,
  connection_type_id INTEGER,
  FOREIGN KEY (origin_id) REFERENCES Nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (destiny_id) REFERENCES Nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_type_id) REFERENCES Connection_types(id)
);

CREATE INDEX idx_node_connection_retrieval ON Node_connections (origin_id, destiny_id);

CREATE INDEX idx_node_type_retrieval ON Node_connections (connection_type_id);

-- Inherited Tags
CREATE TABLE IF NOT EXISTS Inherited_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER,
  tag_id INTEGER,
  FOREIGN KEY (connection_id) REFERENCES Node_connections(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES Tags(id) ON DELETE CASCADE
);

CREATE INDEX idx_inherited_connection_retrieval ON Inherited_tags (connection_id);

CREATE INDEX idx_inherited_tag_retrieval ON Inherited_tags (tag_id);

-- Path Connections
CREATE TABLE IF NOT EXISTS Path_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER,
  path_id INTEGER,
  FOREIGN KEY (connection_id) REFERENCES Node_connections(id) ON DELETE CASCADE,
  FOREIGN KEY (path_id) REFERENCES Path(id) ON DELETE CASCADE
);

CREATE INDEX idx_path_connection_retrieval ON Path_connections (connection_id);

-- Entries for Media_types
INSERT INTO
  Media_types (name, file_extension)
VALUES
  ('Document', 'txt'),
  ('Document', 'md'),
  ('Document', 'json'),
  ('Document', 'csv'),
  ('Document', 'xml'),
  ('Document', 'html'),
  ('Document', 'css'),
  ('Document', 'js'),
  ('Document', 'ts'),
  ('Document', 'pdf'),
  ('Document', 'doc'),
  ('Document', 'docx'),
  ('Document', 'xls'),
  ('Document', 'xlsx'),
  ('Document', 'svg'), 

  ('Image', 'jpg'),
  ('Image', 'jpeg'),
  ('Image', 'png'),
  ('Image', 'gif'),
  ('Image', 'bmp'),

  ('Audio', 'mp3'),
  ('Audio', 'wav'),

  ('Video', 'mp4'),
  ('Video', 'avi'),

  ('Archive', 'zip'),
  ('Archive', 'rar');

-- Entries for Node_types
INSERT INTO
  Node_types (name)
VALUES
  ('Folder'),
  ('Document'),
  ('Flashcard'),
  ('Tag');

INSERT INTO
   Connection_types (name)
VALUES
  (''),
  ('Tagged');


PRAGMA foreign_keys = ON;
`;

const init_config = {
  config: {
    current: {
      workspace_id: 0,
    },
    workspaces: [
      {
        id: 0,
        name: "Flashback",
        description: "",
        path: "flashback",
        db: "flashback.db", 
      },
    ],
  },
};

export { integrity_sql, init_sql, init_config };
