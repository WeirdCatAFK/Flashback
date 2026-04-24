import knex from 'knex';

const k = knex({ client: 'sqlite3', useNullAsDefault: true });

const tables = [];

// Helper to add table to the list
const addTable = (name, builder) => {
    const sql = k.schema.createTable(name, builder).toString();
    // Fix #1: createTable doesn't support IF NOT EXISTS natively, so we patch it
    tables.push(sql.replace(/^create table /i, 'create table if not exists '));
};

// 1. Nodes & Types
addTable('NodeTypes', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
});

addTable('Nodes', (table) => {
    table.increments('id').primary();
    table.integer('type_id').references('id').inTable('NodeTypes');
});

// 2. Folders
addTable('Folders', (table) => {
    table.increments('id').primary();
    table.string('global_hash', 500);
    table.integer('node_id').references('id').inTable('Nodes');
    table.integer('parent_id').references('id').inTable('Folders').onDelete('CASCADE');
    table.string('relative_path', 500);
    table.string('absolute_path', 500);
    table.string('name', 255).index();
    table.string('origin', 500);
    table.float('presence').index();
});

// 3. Documents
addTable('Documents', (table) => {
    table.increments('id').primary();
    table.integer('folder_id').references('id').inTable('Folders').onDelete('CASCADE');
    table.integer('node_id').references('id').inTable('Nodes');
    table.string('global_hash', 500);
    table.string('relative_path', 500);
    table.string('absolute_path', 500);
    table.string('name', 255).index();
    table.string('origin', 500);
    table.string('encoding', 20);
    table.float('presence').index();
});

// 4. Flashcard Components
addTable('FlashcardContent', (table) => {
    table.increments('id').primary();
    table.text('custom_html');
    table.text('render_html');
    table.string('frontText', 500);
    table.string('backText', 500);
    table.string('front_img', 500);
    table.string('back_img', 500);
    table.string('front_sound', 500);
    table.string('back_sound', 500);
});

addTable('FlashcardReference', (table) => {
    table.increments('id').primary();
    table.string('type', 500).index();
    table.float('start');
    table.float('end');
    table.integer('page');
    // Fix: use .text() for JSON storage in SQLite (no native json affinity)
    table.text('bbox');
});

addTable('PedagogicalCategories', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
    table.integer('priority');
    table.text('description');
});

// 5. Flashcards
addTable('Flashcards', (table) => {
    table.increments('id').primary();
    table.string('global_hash', 500).notNullable();
    table.integer('node_id').notNullable().references('id').inTable('Nodes');
    table.integer('document_id').references('id').inTable('Documents').onDelete('CASCADE');
    table.integer('category_id').references('id').inTable('PedagogicalCategories');
    table.integer('content_id').notNullable().references('id').inTable('FlashcardContent');
    table.integer('reference_id').references('id').inTable('FlashcardReference');
    table.integer('level');
    table.timestamp('last_recall').index();
    table.string('name', 255).index();
    table.string('origin', 500);
    table.float('presence').index();
    table.integer('fileIndex');
});

// 6. Logs & Tags
addTable('ReviewLogs', (table) => {
    table.increments('id').primary();
    table.integer('flashcard_id').notNullable().references('id').inTable('Flashcards').onDelete('CASCADE');
    table.timestamp('timestamp').index();
    table.integer('outcome').index();
    table.float('ease_factor').index();
    table.integer('level').index();
});

addTable('Tags', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
    table.integer('node_id').references('id').inTable('Nodes').onDelete('CASCADE');
    table.string('origin', 500);
    table.float('presence');
});

// 7. Connections
addTable('ConnectionTypes', (table) => {
    table.increments('id').primary();
    table.string('name', 255).index();
    // Fix: use integer instead of boolean for SQLite compatibility (0/1)
    table.integer('is_directed');
});

addTable('Connections', (table) => {
    table.increments('id').primary();
    table.integer('origin_id').notNullable().references('id').inTable('Nodes').onDelete('CASCADE').index();
    table.integer('destiny_id').notNullable().references('id').inTable('Nodes').onDelete('CASCADE').index();
    table.integer('type_id').references('id').inTable('ConnectionTypes').index();
});

addTable('InheritedTags', (table) => {
    table.increments('id').primary();
    table.integer('connection_id').references('id').inTable('Connections').onDelete('CASCADE').index();
    table.integer('tag_id').references('id').inTable('Tags').onDelete('CASCADE');
});

// 8. Media & Subscriptions
addTable('Media', (table) => {
    table.increments('id').primary();
    table.string('hash', 500).unique().index();
    table.string('name', 500).index();
    table.string('relative_path', 500);
    table.string('absolute_path', 255);
});

addTable('Subscriptions', (table) => {
    table.increments('id').primary();
    table.string('magazine_id', 500).unique().index();
    table.string('issue_id', 500);
    table.string('version', 100);
    table.string('target_path', 500);
    table.timestamp('last_sync').defaultTo(k.fn.now());
});

// Trigger and additional setup SQL
const extraSQL = `
PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS delete_document_node
AFTER DELETE ON Documents
BEGIN
    DELETE FROM Nodes WHERE id = OLD.node_id;
END;

CREATE TRIGGER IF NOT EXISTS delete_folder_node
AFTER DELETE ON Folders
BEGIN
    DELETE FROM Nodes WHERE id = OLD.node_id;
END;

CREATE TRIGGER IF NOT EXISTS delete_flashcard_node
AFTER DELETE ON Flashcards
BEGIN
    DELETE FROM Nodes WHERE id = OLD.node_id;
END;

CREATE TRIGGER IF NOT EXISTS delete_tag_node
AFTER DELETE ON Tags
BEGIN
    DELETE FROM Nodes WHERE id = OLD.node_id;
END;

CREATE TRIGGER IF NOT EXISTS delete_flashcard_content
AFTER DELETE ON Flashcards
BEGIN
    DELETE FROM FlashcardContent WHERE id = OLD.content_id;
    -- Fix: guard against NULL reference_id before deleting
    DELETE FROM FlashcardReference WHERE OLD.reference_id IS NOT NULL AND id = OLD.reference_id;
END;
`;

const schemaSQL = tables.join(';\n').replace(/CREATE INDEX/gi, 'CREATE INDEX IF NOT EXISTS') + ';\n' + extraSQL;

export default schemaSQL;