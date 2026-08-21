// Module that returns a true value if the config is ready to use, using the validator modules
import validateConfig from './validators/config.js';
import validateDatabase from './validators/database.js';


/**
 * Checks that the config file exists and is valid, and that the database is valid, has every
 * required table, and has had every pending migration applied.
 *
 * ASYNC, AND EVERY CALLER MUST AWAIT IT. `validateDatabase` became async when the data layer
 * did; while this function was synchronous it evaluated `validateDatabase()` as a promise —
 * always truthy — and so returned `true` before the database had been so much as opened.
 * Nothing caught it because the validation invariably finished during whatever the caller did
 * next. It stopped finishing in time once migration 010 had real work to do.
 *
 * @returns {Promise<boolean>} true when the config and the database are both usable.
 */
async function validate() {
    if (!validateConfig()) return false;
    return await validateDatabase();
}
export default validate;


