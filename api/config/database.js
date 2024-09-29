const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const util = require("util");

class DatabaseManager {
  constructor() {
    const config = JSON.parse(
      fs.readFileSync("./data/config.json", "utf8")
    ).config;
    const currentWorkspace = config.workspaces.find(
      (workspace) => workspace.id === config.current.workspace_id
    );

    if (!currentWorkspace) {
      throw new Error("Current workspace not found in config.");
    }

    this.init_sql = fs.readFileSync("./config/init/init.sql", "utf8");
    this.integrity_sql = fs.readFileSync("./config/init/integrity.sql", "utf8");

    this.db = new sqlite3.Database(currentWorkspace.db);

    this.get = util.promisify(this.db.get.bind(this.db));
    this.all = util.promisify(this.db.all.bind(this.db));
    this.run = util.promisify(this.db.run.bind(this.db));
    this.each = util.promisify(this.db.each.bind(this.db));
    this.serialize = util.promisify(this.db.serialize.bind(this.db));
  }

  async checkDatabaseIntegrity() {
    try {
      const result = await this.get(this.integrity_sql);
      return result["COUNT(*)"] === 16; // Checking if all 16 tables exist (may change later for a different integrity test)
    } catch (error) {
      console.error("Error checking database integrity:", error);
      return false;
    }
  }

  async initializeDatabase() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run("BEGIN TRANSACTION;");

        const statements = this.init_sql
          .split(";")
          .filter((stmt) => stmt.trim() !== "");

        statements.forEach((statement) => {
          this.db.run(statement, (err) => {
            if (err) {
              console.error("Error executing statement:", statement);
              console.error("Error details:", err);
            }
          });
        });

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
      });
    });
  }

  async initialize() {
    const isIntact = await this.checkDatabaseIntegrity();
    if (!isIntact) {
      console.log("Database integrity check failed. Reinitializing...");
      await this.initializeDatabase();
    } else {
      console.log("Database integrity check passed.");
    }
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

const dbManager = new DatabaseManager();

module.exports = dbManager;
