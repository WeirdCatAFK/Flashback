// Module that returns a true value if the config is ready to use, using the validator modules
import validateConfig from './validators/config.js';
import validateDatabase from './validators/database.js';


/**
 * Checks if the config file exists and is valid, and if the database is valid and has all required tables.
 * Returns true if the config file is valid and the database is valid, false otherwise.
 * @returns {boolean} True if the config file is valid and the database is valid, false otherwise.
 */
function validate() {
    if (validateConfig() && validateDatabase()) return true
    return false
}
export default validate;


