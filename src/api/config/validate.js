// Module that returns a true value if the config is ready to use, using the validator modules
import validateEnv from './validators/env.js';
import validateConfig from './validators/config.js';
import validateDatabase from './validators/database.js';
function validate() {
    const env = validateEnv();
    if (env) {
        if (validateConfig({ env: env })) return true
        if (validateDatabase()) return true
        return false
    } else {
        console.log("Couldn't identify the environment on validation");
        return false
    }

}

export default validate;


