//This module should read the config.jhson file and return all the data\
import path from "path";
import fs from 'fs'
let configPath = "";
let dataPath = "";
export function get() {
    if (process.versions.electron) {
        if (!process.env.USER_DATA_PATH) throw new Error("USER_DATA_PATH env var is not set");
        dataPath = process.env.USER_DATA_PATH;
        configPath = path.join(dataPath, "config.json");
    }
    if (process.versions.node) {
        // Since not in electron we don't have direct access to the appData folder
        dataPath = process.cwd();
        configPath = path.join(dataPath, "data", "config.json");
    }
    if (!(process.versions.electron || process.versions.node)) {
        console.log("Not running in electron or node environment");
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
export function set(config) {
    if (process.versions.electron) {
        if (!process.env.USER_DATA_PATH) throw new Error("USER_DATA_PATH env var is not set");
        dataPath = process.env.USER_DATA_PATH;
        configPath = path.join(dataPath, "config.json");
    } else if (process.versions.node) {
        dataPath = process.cwd();
        configPath = path.join(dataPath, "data", "config.json");
    } else {
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



