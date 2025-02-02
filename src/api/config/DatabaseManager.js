import fs from "fs";
import util from "util";
import sqlite3 from "sqlite3";
import path from "path";
import ConfigManager from "./ConfigManager.js";
import { init_sql, integrity_sql } from "./Init.js";
import { app } from "electron";

const userDataPath = app.getPath("userData");
app.getPath("userData");

class DatabaseManager {
  constructor() {
    this.initializeDatabase();
  }

  async initializeDatabase() {
    try {
      this.dbPath = this.getDBPath();
      this.setupDatabase();
      this.promisifyDatabaseMethods();

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
    const currentWorkspace = ConfigManager.current_workspace;

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
      console.log("Database file doesn't exist");
    }

    this.db = new sqlite3.Database(this.dbPath);
  }

  promisifyDatabaseMethods() {
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
      this.db.serialize(async () => {
        try {
          await this.run("BEGIN TRANSACTION;");

          const statements = this.init_sql
            .split(";")
            .filter((stmt) => stmt.trim() !== "");

          for (const statement of statements) {
            try {
              await this.run(statement);
              console.log(`Executed: ${statement}`);
            } catch (err) {
              console.error(`Error executing statement: ${statement}`, err);
              await this.run("ROLLBACK;");
              reject(err);
              return;
            }
          }

          await this.run("COMMIT;");
          console.log("Database initialized successfully");
          resolve();
        } catch (err) {
          console.error("Error during transaction:", err);
          await this.run("ROLLBACK;");
          reject(err);
        }
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
