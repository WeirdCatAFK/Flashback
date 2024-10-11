const fs = require("fs");
const path = require("path");

const initConfigPath = path.join(__dirname, "../config/init/init_config.json");
const configPath = path.join(__dirname, "../data/config.json");

class IntegrityManager {
  constructor() {}

  async checkConfigIntegrity() {
    let config;

    try {
      // Check if config file exists
      if (fs.existsSync(configPath)) {
        try {
          // Try to load the existing config file
          config = require(configPath);
        } catch (error) {
          console.error("Error loading config.json:", error);
          // If loading the config fails, attempt to restore from init_config
          config = require(initConfigPath);
          await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
          console.log("Config file restored from init_config.");
        }
      } else {
        // If config file doesn't exist, create it from init_config
        console.log("Config file not found, loading default config.");
        const initConfig = require(initConfigPath);
        config = initConfig;

        await fs.promises.writeFile(configPath, JSON.stringify(initConfig, null, 2));
        console.log("Config file created from init_config.");
      }
      
      // If we get here, the config is usable
      return true;
    } catch (error) {
      // If any error occurs, log it and return false
      console.error("Error ensuring config integrity:", error);
      return false;
    }
  }
}

const integrityManager = new IntegrityManager();
module.exports = integrityManager;
