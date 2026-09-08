// Module that returns a true value if the config is ready to use, using the validator modules
import validateConfig from './validators/config.js';
import validateDatabase from './validators/database.js';

/**
 * Checks that the config file exists and is valid, and that the database is valid, has every required table, and has had every pending migration…
 *
 * @returns {Promise<boolean>} true when the config and the database are both usable.
 */
async function validate() {
    if (!validateConfig()) return false;
    return await validateDatabase();
}
export default validate;

