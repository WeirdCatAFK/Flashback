//The purpose of this file is to handle all the integrity checks for the config before loading the app
//Integrity used as "correct"
import fs from "fs";
import path from "path";
import ConfigManager from "./ConfigManager.js";
import { init_config } from "./init.js";

class IntegrityManager {
  constructor() {}

  async checkConfigIntegrity() {
    try {
      // Ensure the data directory exists
      await fs.promises.mkdir(path.dirname(ConfigManager.configPath), {
        recursive: true,
      });

      // Check if config file exists
      if (fs.existsSync(ConfigManager.configPath)) {
        try {
          // Try to load the existing config file
          ConfigManager.loadConfig();
        } catch (error) {
          console.error("Error loading config.json:", error);
          // If loading the config fails, attempt to restore from init_config
          ConfigManager.config = init_config;
          ConfigManager.saveConfig();
          console.log("Config file restored from init_config.");
        }
      } else {
        // If config file doesn't exist, create it from init_config
        console.log("Config file not found, loading default config.");
        ConfigManager.config = init_config;
        ConfigManager.saveConfig();
        console.log("Config file created from init_config.");
      }

      return true;
    } catch (error) {
      console.error("Error ensuring config integrity:", error);
      return false;
    }
  }
}

export default new IntegrityManager();
