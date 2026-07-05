import { get } from "../../access/config.js";

const required = ["port", "logFormat", "host", "isLocalhost"];

function validateConfig() {
    const config = get();
    if (!config) return false;

    const missing = required.filter((key) => !(key in config));
    if (missing.length > 0) {
        console.error("Config file is missing parameters:", missing);
        return false;
    }
    return true;
}

export default validateConfig;
