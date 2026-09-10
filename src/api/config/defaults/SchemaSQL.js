import knex from 'knex';

const k = knex({ client: 'sqlite3', useNullAsDefault: true });

const tables = [];

const addTable = (name, builder) => {
    const sql = k.schema.createTable(name, builder).toString();
    tables.push(sql.replace(/^create table /i, 'create table if not exists '));
};

addTable('NodeTypes', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
});

addTable('Nodes', (table) => {
    table.increments('id').primary();
    table.integer('type_id').references('id').inTable('NodeTypes');
});

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

addTable('FlashcardContent', (table) => {
    table.increments('id').primary();
    table.text('custom_html');
    table.text('render_html');
    table.string('frontText', 500);
    table.string('backText', 500);
    table.string('answerText', 500);
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
    table.text('bbox');
});

addTable('PedagogicalCategories', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
    table.integer('priority');
    table.text('description');
});

addTable('Flashcards', (table) => {
    table.increments('id').primary();
    table.string('global_hash', 500).notNullable();
    table.integer('node_id').notNullable().references('id').inTable('Nodes');
    table.integer('document_id').references('id').inTable('Documents').onDelete('CASCADE');
    table.integer('category_id').references('id').inTable('PedagogicalCategories');
    table.integer('content_id').notNullable().references('id').inTable('FlashcardContent');
    table.integer('reference_id').references('id').inTable('FlashcardReference');
    table.string('name', 255).index();
    table.string('origin', 500);
    table.float('presence').index();
    table.integer('fileIndex');
    table.string('card_type', 50).notNullable().defaultTo('basic');
});

addTable('Highlights', (table) => {
    table.increments('id').primary();
    table.integer('document_id').references('id').inTable('Documents').onDelete('CASCADE');
    table.string('global_hash', 500).notNullable().unique();
    table.string('type', 50).notNullable().defaultTo('text_offset');
    table.float('start');
    table.float('end');
    table.integer('page');
    table.text('bbox');
    table.string('color', 20).notNullable().defaultTo('amber');
    table.text('note');
    table.timestamp('created_at').defaultTo(k.fn.now());
});

addTable('ReviewLogs', (table) => {
    table.increments('id').primary();
    table.integer('flashcard_id').notNullable().references('id').inTable('Flashcards').onDelete('CASCADE');
    table.string('account_id', 64).notNullable().defaultTo('owner');
    table.timestamp('timestamp').index();
    table.integer('outcome').index();
    table.float('ease_factor').index();
    table.integer('level').index();
    table.string('algorithm', 20);
    table.integer('rating');
    table.float('fsrs_stability');
    table.float('fsrs_difficulty');
    table.timestamp('fsrs_due');
    table.integer('fsrs_state');
    table.string('session_id', 64).index();
    table.integer('session_position');
    table.integer('prev_distance');
    table.integer('nearest_sibling_lag');
});

addTable('Tags', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
    table.integer('node_id').references('id').inTable('Nodes').onDelete('CASCADE');
    table.string('origin', 500);
    table.float('presence');
});

addTable('ConnectionTypes', (table) => {
    table.increments('id').primary();
    table.string('name', 255).index();
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

addTable('DocumentLinks', (table) => {
    table.increments('id').primary();
    table.string('source_hash', 500).notNullable();
    table.string('target_hash', 500).notNullable();
    table.string('anchor_text', 500);
    table.unique(['source_hash', 'target_hash']);
});

addTable('Decks', (table) => {
    table.increments('id').primary();
    table.integer('node_id').references('id').inTable('Nodes');
    table.string('global_hash', 500).notNullable().unique().index();
    table.string('name', 500).notNullable();
    table.text('description');
    table.integer('is_system').notNullable().defaultTo(0);
    table.timestamp('created_at').defaultTo(k.fn.now());
    table.timestamp('updated_at').defaultTo(k.fn.now());
});

addTable('DeckEntries', (table) => {
    table.increments('id').primary();
    table.integer('deck_id').notNullable().references('id').inTable('Decks').onDelete('CASCADE');
    table.string('card_hash', 500).notNullable();
    table.string('document_path', 500);
    table.integer('position').defaultTo(0);
    table.text('inline_card');
});

addTable('CanonicalVersion', (table) => {
    table.integer('version').primary();
    table.timestamp('applied_at').defaultTo(k.fn.now());
    table.text('description');
});

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

CREATE TRIGGER IF NOT EXISTS delete_deck_node
AFTER DELETE ON Decks
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_global_hash ON Documents(global_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_global_hash ON Folders(global_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flashcards_global_hash ON Flashcards(global_hash);

CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON Folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_absolute_path ON Folders(absolute_path);
CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON Documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_absolute_path ON Documents(absolute_path);
CREATE INDEX IF NOT EXISTS idx_flashcards_document_id ON Flashcards(document_id);
CREATE INDEX IF NOT EXISTS idx_media_absolute_path ON Media(absolute_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_global_hash ON Highlights(global_hash);
CREATE INDEX IF NOT EXISTS idx_highlights_document_id ON Highlights(document_id);
CREATE INDEX IF NOT EXISTS idx_doclinks_source ON DocumentLinks(source_hash);
CREATE INDEX IF NOT EXISTS idx_doclinks_target ON DocumentLinks(target_hash);
CREATE INDEX IF NOT EXISTS idx_reviewlogs_account_card ON ReviewLogs(account_id, flashcard_id);
`;

const schemaSQL = tables.join(';\n')
    .replace(/CREATE UNIQUE INDEX\b/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS')
    .replace(/CREATE INDEX\b/gi, 'CREATE INDEX IF NOT EXISTS')
    + ';\n' + extraSQL;

export default schemaSQL;