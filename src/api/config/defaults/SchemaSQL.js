import knex from 'knex';

const k = knex({ client: 'sqlite3', useNullAsDefault: true });

const tables = [];

// Helper to add table to the list
const addTable = (name, builder) => {
    const sql = k.schema.createTable(name, builder).toString();
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
    // type_answer only: the value the reviewer's typed answer is compared against.
    // `backText` is then free prose shown after checking (a mnemonic, a why), which is
    // never compared. NULL means the card predates the split and its answer is still in
    // `backText` — see DATAMODEL.md § Flashcard Types and migration 008.
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
    // NO SRS STATE HERE. A card's schedule belongs to a PERSON, not to the card — see
    // CardProgress below and migration 010, which moved `level`, `sm2_reps`, `last_recall`
    // and the six `fsrs_*` columns off this table. Do not reintroduce them: a column that
    // still reads is worse than one that throws, and the whole point of dropping them was
    // that a query which forgets to scope itself must fail loudly rather than quietly
    // serve one person another person's schedule.
    table.string('name', 255).index();
    table.string('origin', 500);
    table.float('presence').index();
    table.integer('fileIndex');
    table.string('card_type', 50).notNullable().defaultTo('basic');
});

// One person's schedule for one card. Split off Flashcards by migration 010 so that several
// people can study one vault without grading each other's cards.
//
// `account_id` is an account id from the accounts store, or the literal 'owner'. There is no
// foreign key and there cannot be one: accounts live in `{baseDir}/accounts.db`, a different
// database file entirely, deliberately outside the vault so a copied vault carries no access
// list. 'owner' is the Author, stored as a sentinel rather than their uuid for exactly the
// same reason — a vault copied to another install must keep its owner progress instead of
// orphaning every row. See requestContext.js OWNER_SCOPE.
//
// A missing row means "never reviewed by this person", which is already what a zero level and
// a NULL last_recall meant. So every read COALESCEs and no backfill-on-first-review is needed.
//
// Derived, like everything else in this database. The owner's copy of it is canonical in the
// `.flashback` sidecar; everyone else's is canonical in the accounts store's AccountProgress.
addTable('CardProgress', (table) => {
    table.increments('id').primary();
    table.integer('flashcard_id').notNullable()
        .references('id').inTable('Flashcards').onDelete('CASCADE');
    table.string('account_id', 64).notNullable().defaultTo('owner');
    table.integer('level');
    table.integer('sm2_reps').notNullable().defaultTo(0);
    table.timestamp('last_recall').index();
    // FSRS-6 per-card state (used when the active algorithm is 'fsrs')
    table.float('fsrs_stability');
    table.float('fsrs_difficulty');
    table.timestamp('fsrs_due');
    table.integer('fsrs_state').notNullable().defaultTo(0);
    table.integer('fsrs_reps').notNullable().defaultTo(0);
    table.integer('fsrs_lapses').notNullable().defaultTo(0);
    table.unique(['flashcard_id', 'account_id']);
});

// 6. Highlights
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

// 7. Logs & Tags
addTable('ReviewLogs', (table) => {
    table.increments('id').primary();
    table.integer('flashcard_id').notNullable().references('id').inTable('Flashcards').onDelete('CASCADE');
    // WHOSE review this was: an account id, or 'owner' for the vault's Author (see
    // requestContext.js OWNER_SCOPE). NOT NULL with a default rather than nullable, because
    // NULL already means "not recorded" for the ordering columns below and an ambiguous
    // sentinel here would silently fold one person's history into everyone's statistics.
    // Indexed as (account_id, flashcard_id) down in the index block, NEVER on its own: a
    // vault has one account per person and most have exactly one, so an index on this column
    // alone matches nearly every row — and SQLite's planner, seeing an equality match on an
    // indexed column, will take it and abandon a far better join order. It did: the diary's
    // per-deck rollup went from 24ms to 500ms on a real vault the day the scope column landed.
    table.string('account_id', 64).notNullable().defaultTo('owner');
    table.timestamp('timestamp').index();
    table.integer('outcome').index();
    table.float('ease_factor').index();
    table.integer('level').index();
    // Which scheduler graded this review ('leitner' | 'sm2' | 'fsrs'). The active
    // algorithm is a browser preference, so this is the only place the server can
    // learn it — see access/orchestration/srs.js detectAlgorithm(). NULL on pre-migration rows.
    table.string('algorithm', 20);
    // FSRS: the real 1–4 grade + post-review state snapshot (for undo & fitting)
    table.integer('rating');
    table.float('fsrs_stability');
    table.float('fsrs_difficulty');
    table.timestamp('fsrs_due');
    table.integer('fsrs_state');
    // How this card was PRESENTED, not how it was graded — written by the trainer so a
    // retention dip after interleaving turned on can be told apart from a regression.
    // See migrations/009_session_ordering.js. All NULL for reviews submitted outside a
    // trainer session (e.g. the MCP server); NULL means "not recorded", never "distance 0".
    table.string('session_id', 64).index();
    table.integer('session_position');
    table.integer('prev_distance');
    table.integer('nearest_sibling_lag');
});

// Active FSRS weight vector, ONE ROW PER ACCOUNT (seeded lazily with published defaults on
// first read). Derived data, so it lives in the DB.
//
// Per-account and not per-vault because the weights are a fitted model of one person's
// forgetting curve. Applying the owner's fitted weights to a reader's schedule would not be
// a small inaccuracy — it would schedule that reader against someone else's memory. This is
// also why /api/srs/optimize is a reader-level action rather than an administrative one.
addTable('FsrsParameters', (table) => {
    table.increments('id').primary();
    table.string('account_id', 64).notNullable().defaultTo('owner');
    table.text('weights_json').notNullable();
    table.timestamp('optimized_at');
    table.integer('review_count');
    table.unique(['account_id']);
});

// Card health — derived failure-signature classification (see migration 007 and
// DATAMODEL.md § Card Health). Deliberately absent from the `.flashback` sidecars:
// a flag is recomputable from ReviewLogs + the card's content, and sealing one would
// mean a git commit on every failed review.
//
// CardHealth is the *analysis watermark*, one row per evaluated card. A flag is a live
// judgement, not a permanent scar — once the user addresses a card (edits it, or reviews
// it back up to strength) analysis restarts from `epoch_at`, so history from before the
// fix is never held against the card that replaced it.
addTable('CardHealth', (table) => {
    table.increments('id').primary();
    table.integer('flashcard_id').notNullable()
        .references('id').inTable('Flashcards').onDelete('CASCADE');
    // Per (card, account): the verdict is about how the card is built, but the evidence is
    // one person's interval trajectory, so two people can be mid-analysis on the same card
    // at different watermarks. An edit needs no cross-account bump — each row compares
    // against the card's CURRENT content_fingerprint on its own next evaluation, so a
    // rewritten card invalidates everyone's analysis lazily and for free.
    table.string('account_id', 64).notNullable().defaultTo('owner');
    table.timestamp('epoch_at');
    table.string('epoch_reason', 20);      // 'edit' | 'recovered' | 'dismissed'
    table.string('content_fingerprint', 64);
    table.timestamp('updated_at');
    table.unique(['flashcard_id', 'account_id']);
});

// One row per currently-raised flag. UNIQUE(flashcard_id, kind) because a card either
// currently reads as a mouthful or it doesn't — re-raising refreshes the evidence rather
// than stacking duplicates. `dismissed_at` suppresses a flag the user has already ruled
// on instead of deleting it, so it stops re-announcing itself on every later failure.
addTable('CardFlags', (table) => {
    table.increments('id').primary();
    table.integer('flashcard_id').notNullable()
        .references('id').inTable('Flashcards').onDelete('CASCADE');
    table.string('account_id', 64).notNullable().defaultTo('owner');
    table.string('kind', 40).notNullable().index();
    table.string('confidence', 20).notNullable();
    table.float('score');
    table.text('evidence_json');
    table.integer('level_at_detection');
    table.timestamp('detected_at');
    table.integer('review_log_id');
    table.timestamp('dismissed_at');
    table.unique(['flashcard_id', 'account_id', 'kind']);
});

addTable('Tags', (table) => {
    table.increments('id').primary();
    table.string('name', 500).index();
    table.integer('node_id').references('id').inTable('Nodes').onDelete('CASCADE');
    table.string('origin', 500);
    table.float('presence');
});

// 8. Connections
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

// 9. Document Links (hash-based queue; no FK constraints — resolves lazily on import)
addTable('DocumentLinks', (table) => {
    table.increments('id').primary();
    table.string('source_hash', 500).notNullable();
    table.string('target_hash', 500).notNullable();
    table.string('anchor_text', 500);
    table.unique(['source_hash', 'target_hash']);
});

// 10. Decks
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

// Canonical-layer updates this vault has finished (config/UpdateRunner.js), as opposed to
// SchemaVersion which tracks schema changes to this derived database. Separate mechanisms
// because a canonical rewrite does file IO and ends in a Seal commit, neither of which
// belongs inside a migration's transaction.
//
// This table is an OPTIMISATION, not the source of truth: it lets startup skip walking the
// vault when nothing is pending. The authority is the `formatVersion` stamped on each
// canonical file, so a sidecar restored from a backup or an old Seal commit still says what
// it is. A row is written only once a pass completes with nothing skipped.
addTable('CanonicalVersion', (table) => {
    table.integer('version').primary();
    table.timestamp('applied_at').defaultTo(k.fn.now());
    table.text('description');
});

// 10. Media & Subscriptions
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
CREATE INDEX IF NOT EXISTS idx_cardprogress_account ON CardProgress(account_id);
CREATE INDEX IF NOT EXISTS idx_reviewlogs_account_card ON ReviewLogs(account_id, flashcard_id);
CREATE INDEX IF NOT EXISTS idx_cardhealth_flashcard ON CardHealth(flashcard_id);
CREATE INDEX IF NOT EXISTS idx_cardflags_flashcard ON CardFlags(flashcard_id);
`;

const schemaSQL = tables.join(';\n')
    .replace(/CREATE UNIQUE INDEX\b/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS')
    .replace(/CREATE INDEX\b/gi, 'CREATE INDEX IF NOT EXISTS')
    + ';\n' + extraSQL;

export default schemaSQL;