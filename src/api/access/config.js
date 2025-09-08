//This module should read the config.jhson file and return all the data\
import path from "path";
import fs from 'fs'
import validateEnv from './../config/validators/env.js';
const env = validateEnv();
let configPath = "";
let dataPath = "";
export async function get() {
    if (env === "electron") {
        dataPath = process.env.USER_DATA_PATH;
        configPath = path.join(dataPath, "config.json");
    }
    if (env === "node") {
        // Since not in electron we don't have direct access to the appData folder
        dataPath = process.cwd();
        configPath = path.join(dataPath, "data", "config.json");
    }
    if (!env) {
        console.log("Couldn't identify the environment");
        return false;
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return config;
    } catch (error) {
        console.error("Error reading config file:", error);
        return false;
    }
}
export async function set(config) {
    if (env === "electron") {
        dataPath = process.env.USER_DATA_PATH;
        configPath = path.join(dataPath, "config.json");

    }
    if (env === "node") {
        dataPath = process.cwd();
        configPath = path.join(dataPath, "data", "config.json");
    }
    if (!env) {
        console.log("Couldn't identify the environment");
        return false;
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('Config file updated successfully');
        return true;
    } catch (error) {
        console.error("Error reading config file:", error);
        return false;
    }
}



