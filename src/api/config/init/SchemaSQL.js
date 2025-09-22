export default
    `
-- SQLite database export
PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS "Folders" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "global_hash" VARCHAR(500),
    "node_id" INTEGER,
    "relative_path" VARCHAR(500),
    "absolute_path" VARCHAR(500),
    "name" VARCHAR,
    "presence" FLOAT,
    FOREIGN KEY("node_id") REFERENCES "Nodes"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Folders_name_index"
ON "Folders" ("name");
CREATE INDEX IF NOT EXISTS "Folders_presence_index"
ON "Folders" ("presence");

CREATE TABLE IF NOT EXISTS "Flashcards" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "global_hash" VARCHAR(500) NOT NULL,
    "node_id" INTEGER NOT NULL,
    "document_id" INTEGER,
    "category_id" INTEGER,
    "content_id" INTEGER NOT NULL,
    "reference_id" INTEGER,
    "last_recall" TIMESTAMP,
    "name" VARCHAR NOT NULL,
    "presence" FLOAT,
    FOREIGN KEY("category_id") REFERENCES "PedagogicalCategories"("id"),
    FOREIGN KEY("content_id") REFERENCES "FlashcardContent"("id"),
    FOREIGN KEY("document_id") REFERENCES "Documents"("id"),
    FOREIGN KEY("node_id") REFERENCES "Nodes"("id"),
    FOREIGN KEY("reference_id") REFERENCES "FlashcardReference"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Flashcards_last_recall_index"
ON "Flashcards" ("last_recall");
CREATE INDEX IF NOT EXISTS "Flashcards_presence_index"
ON "Flashcards" ("presence");
CREATE INDEX IF NOT EXISTS "Flashcards_name_index"
ON "Flashcards" ("name");

CREATE TABLE IF NOT EXISTS "FlashcardContent" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "custom_html" TEXT,
    "render_html" TEXT,
    "frontText" VARCHAR(500),
    "backText" VARCHAR(500),
    "front_img" VARCHAR(500),
    "back_img" VARCHAR(500),
    "front_sound" VARCHAR(500),
    "back_sound" VARCHAR(500)
);


CREATE TABLE IF NOT EXISTS "Nodes" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "type_id" INTEGER,
    FOREIGN KEY("type_id") REFERENCES "NodeTypes"("id")
);


CREATE TABLE IF NOT EXISTS "FlashcardReference" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "type" VARCHAR(500),
    "start" FLOAT,
    "end" FLOAT,
    "page" INTEGER,
    "bbox" JSON
);

-- Indexes
CREATE INDEX IF NOT EXISTS "FlashcardReference_type_index"
ON "FlashcardReference" ("type");

CREATE TABLE IF NOT EXISTS "ReviewLogs" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "flashcard_id" INTEGER NOT NULL,
    "timestamp" TIMESTAMP,
    "outcome" INTEGER,
    "ease_factor" FLOAT,
    "level" INTEGER,
    FOREIGN KEY("flashcard_id") REFERENCES "Flashcards"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "ReviewLogs_timestamp_index"
ON "ReviewLogs" ("timestamp");
CREATE INDEX IF NOT EXISTS "ReviewLogs_outcome_index"
ON "ReviewLogs" ("outcome");
CREATE INDEX IF NOT EXISTS "ReviewLogs_ease_factor_index"
ON "ReviewLogs" ("ease_factor");
CREATE INDEX IF NOT EXISTS "ReviewLogs_level_index"
ON "ReviewLogs" ("level");

CREATE TABLE IF NOT EXISTS "NodeTypes" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" VARCHAR(500)
);

-- Indexes
CREATE INDEX IF NOT EXISTS "NodeTypes_name_index"
ON "NodeTypes" ("name");

CREATE TABLE IF NOT EXISTS "InheritedTags" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "connection_id" INTEGER,
    "tag_id" INTEGER,
    FOREIGN KEY("connection_id") REFERENCES "Connections"("id"),
    FOREIGN KEY("tag_id") REFERENCES "Tags"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "InheritedTags_connection_index"
ON "InheritedTags" ("connection_id");

-- "Default values are ["disconection", "inherited"]
CREATE TABLE IF NOT EXISTS "ConnectionTypes" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" VARCHAR,
    "is_directed" BOOLEAN
);

-- Indexes
CREATE INDEX IF NOT EXISTS "ConnectionTypes_name_index"
ON "ConnectionTypes" ("name");

-- Pedagogical categories are to determine priority when reviewing flashcards, let's say category 0 is relation, 1 is definition, 2 concept, and so on, if you need to know definitions to understand a concept you'll like to review them first
CREATE TABLE IF NOT EXISTS "PedagogicalCategories" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" VARCHAR(500),
    "priority" INTEGER,
    "node_id" INTEGER,
    FOREIGN KEY("node_id") REFERENCES "Nodes"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "PedagogicalCategories_name_index"
ON "PedagogicalCategories" ("name");

CREATE TABLE IF NOT EXISTS "Tags" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" VARCHAR(500),
    "node_id" INTEGER,
    "presence" FLOAT,
    FOREIGN KEY("node_id") REFERENCES "Nodes"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Tags_name_index"
ON "Tags" ("name");

CREATE TABLE IF NOT EXISTS "Documents" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "folder_id" INTEGER,
    "node_id" INTEGER,
    "global_hash" VARCHAR(500),
    "relative_path" VARCHAR(500),
    "absolute_path" VARCHAR(500),
    "name" VARCHAR,
    "presence" FLOAT,
    FOREIGN KEY("folder_id") REFERENCES "Folders"("id"),
    FOREIGN KEY("node_id") REFERENCES "Nodes"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Documents_name_index"
ON "Documents" ("name");
CREATE INDEX IF NOT EXISTS "Documents_presence_index"
ON "Documents" ("presence");

-- Actually desembodied from the rest of tables because it stores all media wich will be requested by the frontend with the route/media/hash so to speak
CREATE TABLE IF NOT EXISTS "Media" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "hash" VARCHAR(500),
    "name" VARCHAR(500),
    "relative_path" VARCHAR(500),
    "absolute_path" VARCHAR
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Media_index_2"
ON "Media" ("hash");
CREATE INDEX IF NOT EXISTS "Media_index_3"
ON "Media" ("name");

CREATE TABLE IF NOT EXISTS "Connections" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "origin_id" INTEGER NOT NULL,
    "destiny_id" INTEGER NOT NULL,
    "type_id" INTEGER,
    FOREIGN KEY("destiny_id") REFERENCES "Nodes"("id"),
    FOREIGN KEY("origin_id") REFERENCES "Nodes"("id"),
    FOREIGN KEY("type_id") REFERENCES "ConnectionTypes"("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Connections_type_index"
ON "Connections" ("type_id");

COMMIT;

`