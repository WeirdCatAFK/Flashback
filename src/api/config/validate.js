import validateConfig from './validators/config.js';
import validateDatabase from './validators/database.js';

async function validate() {
    if (!validateConfig()) return false;
    return await validateDatabase();
}
export default validate;

