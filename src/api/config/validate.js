// Module that returns a true value if the config is ready to use, using the validator modules
import validateConfig from './validators/config.js';
import validateDatabase from './validators/database.js';
function validate() {
    if (validateConfig() && validateDatabase()) return true

    return false

}

export default validate;


