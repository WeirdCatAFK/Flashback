import fs from "fs";
import util from "util";
import sqlite3 from "sqlite3";
import path from "path";
import { ConfigManager } from "./configmanager.js";
import { init_sql, integrity_sql } from "./init/init_config.js";
import { app } from "electron";
const userDataPath = app.getPath("userData");

class DatabaseManager {
  constructor() {
    this.configManager = new ConfigManager();
    this.initializeDatabase();
  }

  async initializeDatabase() {
    try {
      this.dbPath = this.getDBPath();
      this.setupDatabase();
      this.promisifyDbMethods();

      console.log("Running database integrity check...");
      const isIntact = await this.checkDatabaseIntegrity();

      if (isIntact) {
        console.log("Database integrity passed. No initialization required.");
      } else {
        console.log(
          "Database integrity check failed. Initializing database..."
        );
        await this.runInitQueries();
        console.log("Database initialized successfully.");
      }
    } catch (error) {
      console.error("Error during initialization:", error);
      throw new Error("Database initialization failed.");
    }
  }

  getDBPath() {
    const currentWorkspace = this.configManager.current_workspace;
    
    const dbPath = path.join(userDataPath, "data", currentWorkspace.db);
    if (!currentWorkspace) {
      throw new Error("Current workspace not found in config");
    }

    return decodeURI(dbPath);
  }

  setupDatabase() {
    this.init_sql = init_sql;
    this.integrity_sql = integrity_sql;

    if (!fs.existsSync(this.dbPath)) {
      console.log("Database file doesn't exist, creating a new one.");
    }

    this.db = new sqlite3.Database(this.dbPath);
  }

  promisifyDbMethods() {
    ["get", "all", "run", "each"].forEach((method) => {
      this[method] = util.promisify(this.db[method].bind(this.db));
    });
    this.serialize = util.promisify(this.db.serialize.bind(this.db));
  }

  async checkDatabaseIntegrity() {
    try {
      const result = await this.get(this.integrity_sql);
      return result && result["COUNT(*)"] === 16;
    } catch (error) {
      console.error("Error checking database integrity:", error);
      return false;
    }
  }

  async runInitQueries() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run("BEGIN TRANSACTION;");

        const statements = this.init_sql
          .split(";")
          .filter((stmt) => stmt.trim() !== "");

        const executeStatements = async () => {
          for (const statement of statements) {
            try {
              await this.run(statement);
              console.log(`Executed: ${statement}`);
            } catch (err) {
              console.error(`Error executing statement: ${statement}`, err);
              this.db.run("ROLLBACK;");
              reject(err);
              return;
            }
          }

          this.db.run("COMMIT;", (err) => {
            if (err) {
              console.error("Error committing transaction:", err);
              this.db.run("ROLLBACK;");
              reject(err);
            } else {
              console.log("Database initialized successfully");
              resolve();
            }
          });
        };

        executeStatements();
      });
    });
  }

  async close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

export default new DatabaseManager();
