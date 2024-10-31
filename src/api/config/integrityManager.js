import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigManager } from './configmanager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const initConfigPath = path.join(__dirname, "../config/init/init_config.json");

class IntegrityManager {
  constructor() {
    this.configManager = new ConfigManager();
  }

  async checkConfigIntegrity() {
    try {
      // Ensure the data directory exists
      await fs.promises.mkdir(path.dirname(this.configManager.configPath), { recursive: true });

      // Check if config file exists
      if (fs.existsSync(this.configManager.configPath)) {
        try {
          // Try to load the existing config file
          this.configManager.loadConfig();
        } catch (error) {
          console.error("Error loading config.json:", error);
          // If loading the config fails, attempt to restore from init_config
          const initConfig = JSON.parse(await fs.promises.readFile(initConfigPath, 'utf8'));
          this.configManager.config = initConfig;
          this.configManager.saveConfig();
          console.log("Config file restored from init_config.");
        }
      } else {
        // If config file doesn't exist, create it from init_config
        console.log("Config file not found, loading default config.");
        const initConfig = JSON.parse(await fs.promises.readFile(initConfigPath, 'utf8'));
        this.configManager.config = initConfig;
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