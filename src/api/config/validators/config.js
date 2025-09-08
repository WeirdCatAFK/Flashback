/*So this file should make the appropiate config files for electron and node.js 
where electron uses the the USER_DATA_PATH env variable and node uses the current working directory
Also it should only return false if it's unable to construct or access
the config file
*/
import path from "path";
import fs from 'fs'
let dataPath = "";
let configPath = "";
function validateConfig({ env }) {
  if (env === "electron") {
    dataPath = process.env.USER_DATA_PATH;
    configPath = path.join(dataPath, "config.json");
  }
  if (env === "node") {
    dataPath = process.cwd();
    configPath = path.join(dataPath, "data", "config.json");
  }
  // After definition of the path, the process will be the same for both config files
  if (!env) {
    console.log("Couldn't identify the environment");
    return false;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const required = ["port", "logFormat", "host", "isLocalhost"];
    const missing = required.filter((key) => !(key in config));
    if (missing.length > 0) {
      console.error("Config file is missing parameters:", missing);
      console.log("Config file path:", configPath);
      return false;
    }
    return true
  } catch (error) {
    console.error("Failed to import config:", error);
    //Routine to create the config file if not found (also neat for first time running)
    if (error.code === "ENOENT") {
      console.warn("Config file not doesn't exist: ", configPath);
      console.log('Creating config file...');

      const defaultConfig = {
        port: 50500,
        logFormat: "dev",
        host: "localhost",
        isLocalhost: true,
      }
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        console.log("Config file created at:", configPath);
        console.log("I hope you are reading this at first run, if not, I think you just lost your files.")
        return true;
      } catch (writeErr) {
        console.error("Failed to create config file:", writeErr);
        return false;
      }
    }
    console.error("Unexpected error reading config:", error);
    return false;
  }
}

export default validateConfig;
