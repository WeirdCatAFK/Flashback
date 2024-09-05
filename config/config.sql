-- To store which method I'll use to play the media
CREATE TABLE `Media_Types` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL
);

-- To store the file extension of documents and media
CREATE TABLE `File_Extensions` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `media_type_id` INT NOT NULL,
    `extension` VARCHAR(10) NOT NULL,
    FOREIGN KEY (`media_type_id`) REFERENCES `Media_Types`(`id`)
);

-- To store if a tag will be hereditary or not (and any other type that occurs to me)
CREATE TABLE `Tag_Types` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL
);

-- To store all the tags
CREATE TABLE `Tags` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `tag_type_id` INT NOT NULL,
    FOREIGN KEY (`tag_type_id`) REFERENCES `Tag_Types`(`id`)
);

-- To store all the documents on the scope of the project (will be relevant later for graph view)
CREATE TABLE `Documents` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `path` TEXT NOT NULL,
    `media_type_id` INT NOT NULL,
    FOREIGN KEY (`media_type_id`) REFERENCES `File_Extensions`(`id`)
);

-- To store all the flashcards on relation to the documents made
CREATE TABLE `Flashcards` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `document_id` INT NOT NULL,
    `text_renderer_id` INT NOT NULL,
    `front` TEXT NULL,
    `back` TEXT NULL,
    FOREIGN KEY (`document_id`) REFERENCES `Documents`(`id`),
    FOREIGN KEY (`text_renderer_id`) REFERENCES `Text_Renderers`(`id`)
);

-- To choose markdown flavor or plain text
CREATE TABLE `Text_Renderers` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `type` VARCHAR(255) NOT NULL
);

-- To store the pairs of ids of flashcards to make connections on graph view
CREATE TABLE `Flashcard_Connections` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `origin_id` INT NOT NULL,
    `destiny_id` INT NOT NULL,
    FOREIGN KEY (`origin_id`) REFERENCES `Flashcards`(`id`),
    FOREIGN KEY (`destiny_id`) REFERENCES `Flashcards`(`id`),
    -- Composite index to optimize lookups by both columns
    INDEX (`origin_id`, `destiny_id`)
);

-- To store the pairs of ids of Documents to make connections on graph view
CREATE TABLE `Document_Connections` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `origin_id` INT NOT NULL,
    `destiny_id` INT NOT NULL,
    FOREIGN KEY (`origin_id`) REFERENCES `Documents`(`id`),
    FOREIGN KEY (`destiny_id`) REFERENCES `Documents`(`id`),
    -- Composite index to optimize lookups by both columns
    INDEX (`origin_id`, `destiny_id`)
);

-- To store the pairs between tags and document ids to make connections on graph view
CREATE TABLE `Document_Tags` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `document_id` INT NOT NULL,
    `tag_id` INT NOT NULL,
    FOREIGN KEY (`document_id`) REFERENCES `Documents`(`id`),
    FOREIGN KEY (`tag_id`) REFERENCES `Tags`(`id`),
    -- Composite index to optimize tag lookups for documents
    INDEX (`document_id`, `tag_id`)
);

-- To store pairs between tags and flashcards ids to make connections on graph view
CREATE TABLE `Flashcard_Tags` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `flashcard_id` INT NOT NULL,
    `tag_id` INT NOT NULL,
    FOREIGN KEY (`flashcard_id`) REFERENCES `Flashcards`(`id`),
    FOREIGN KEY (`tag_id`) REFERENCES `Tags`(`id`),
    -- Composite index to optimize tag lookups for flashcards
    INDEX (`flashcard_id`, `tag_id`)
);

-- To access the media that may be contained in the flashcards
CREATE TABLE `Flashcard_Media` (
    `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `flashcard_id` INT NOT NULL,
    `media_type_id` INT NOT NULL,
    `path` TEXT NOT NULL,
    FOREIGN KEY (`flashcard_id`) REFERENCES `Flashcards`(`id`),
    FOREIGN KEY (`media_type_id`) REFERENCES `Media_Types`(`id`),
    -- Composite index for faster media lookups related to flashcards and types
    INDEX (`flashcard_id`, `media_type_id`)
);