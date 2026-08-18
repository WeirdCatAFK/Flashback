/**
 * The VAULT database — the derived layer, rebuildable from the canonical `.flashback` files.
 *
 * All of the machinery lives in `sqliteAdapter.js`; this module is one instance of it,
 * pointed at whatever vault `config.js` currently resolves. It stayed a module of its own
 * because its default export is the object nine modules import and query.js stores in a
 * constructor — that identity must never change, whatever happens to the connection behind
 * it.
 *
 * The path is resolved PER CALL rather than captured, which is the whole reason an
 * in-process vault switch is possible: `openDatabase()` after `config.reload()` opens the
 * new vault with no importer noticing.
 *
 * The accounts store (`accounts.js`) is the OTHER instance of the same factory. The two
 * share no connection, no queue and no transaction context — see the factory's header for
 * why that separation is load-bearing rather than tidy.
 */

import { createSqliteAdapter } from "./sqliteAdapter.js";
import { getDatabasePath } from "./config.js";

const adapter = createSqliteAdapter({ resolvePath: getDatabasePath });

/**
 * Opens (or re-opens) the connection for whatever vault config.js currently points at.
 * Closes any previous handle first, so callers cannot leak a connection by mistake.
 * @returns {import('better-sqlite3').Database} the raw handle, for callers that need it.
 */
export const openDatabase = adapter.openDatabase;

/** Closes the connection, truncating the WAL on the way out. */
export const closeDatabase = adapter.closeDatabase;

/** @returns {boolean} whether a connection is currently open. */
export const isOpen = adapter.isOpen;

export default adapter.db;
