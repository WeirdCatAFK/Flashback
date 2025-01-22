//The purpose of this file is to handle all the integrity checks for the config before loading the app
//Integrity used as "correct"
import fs from "fs";
import path from "path";
import { ConfigManager } from "./configmanager.js";
import { init_config } from "./init/init_config.js";

class IntegrityManager {
  constructor() {
    this.configManager = new ConfigManager();
  }

  async checkConfigIntegrity() {
    try {
      // Ensure the data directory exists
      await fs.promises.mkdir(path.dirname(this.configManager.configPath), {
        recursive: true,
      });

      // Check if config file exists
      if (fs.existsSync(this.configManager.configPath)) {
        try {
          // Try to load the existing config file
          this.configManager.loadConfig();
        } catch (error) {
          console.error("Error loading config.json:", error);
          // If loading the config fails, attempt to restore from init_config
          this.configManager.config = init_config;
          this.configManager.saveConfig();
          console.log("Config file restored from init_config.");
        }
      } else {
        // If config file doesn't exist, create it from init_config
        console.log("Config file not found, loading default config.");
        this.configManager.config = init_config;
        this.configManager.saveConfig();
        console.log("Config file created from init_config.");
      }

      return true;
    } catch (error) {
      console.error("Error ensuring config integrity:", error);
      return false;
    }
  }
}

const integrityManager = new IntegrityManager();
export default integrityManager;
