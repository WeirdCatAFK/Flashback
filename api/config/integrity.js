const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const initConfigPath = path.join(__dirname, "../config/init/init_config.json");
const configPath = path.join(__dirname, "../data/config.json");

const RETRY_INTERVAL_MS = 5000; 

async function checkDatabaseIntegrity() {
  let config;

  if (fs.existsSync(configPath)) {
    try {
      config = require(configPath);
    } catch (error) {
      console.log("Error loading config.json:", error);
      config = require(initConfigPath);
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
      console.log("Config file restored from init_config");
    }
  } else {
    console.log("Config file not found, loading default config.");
    const initConfig = require(initConfigPath);
    config = initConfig;
    await fs.promises.writeFile(configPath, JSON.stringify(initConfig, null, 2));
    console.log("Config file created from init_config");

  }

  const currentWorkspace = config.config.workspaces.find(
    (workspace) => workspace.id === config.config.current.workspace_id
  );

  if (!currentWorkspace) {
    throw new Error("Current workspace not found in config.");
  }

  const dbPath = currentWorkspace.db;
  const db = new sqlite3.Database(dbPath);

  return new Promise((resolve, reject) => {
    db.get("PRAGMA integrity_check;", (err, result) => {
      if (err) {
        console.error("Error checking database integrity:", err);
        return reject(err);
      }

      if (result && result.integrity_check === "ok") {
        console.log("Database integrity check passed.");
        resolve(true);
      } else {
        console.log("Database integrity check failed. Retrying...");
        resolve(false);
      }

      db.close();
    });
  });
}

// Function to run the integrity check in a loop
async function runIntegrityCheckUntilSuccess() {
  let isIntact = false;

  while (!isIntact) {
    try {
      isIntact = await checkDatabaseIntegrity();
    } catch (error) {
      console.error("Error during integrity check:", error);
    }

    if (!isIntact) {
      console.log(`Retrying in ${RETRY_INTERVAL_MS / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS)); // Wait for the specified retry interval
    }
  }

  console.log("Database integrity is intact. Proceeding...");
}

module.exports = runIntegrityCheckUntilSuccess;
