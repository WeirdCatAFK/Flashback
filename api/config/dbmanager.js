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
      console.log("Current workspace not found, defaulting workspace");
      try {
        config.current.workspace_id = 0;
        fs.writeFileSync(
          "./data/config.json",
          JSON.stringify({ config: config }, null, 2)
        );
        console.log("Defaulted workspace");
      } catch (error) {
        console.error("Couldn't set default workspace: ", error);
      }
    }

    this.init_sql = fs.readFileSync("./config/init/init.sql", "utf8");
    this.integrity_sql = fs.readFileSync("./config/init/integrity.sql", "utf8");
    this.dbPath = decodeURI(currentWorkspace.db);

    if (!fs.existsSync(this.dbPath)) {
      console.log("Database file doesn't exist, creating a new one.");
    }

    this.db = new sqlite3.Database(this.dbPath);

    this.get = util.promisify(this.db.get.bind(this.db));
    this.all = util.promisify(this.db.all.bind(this.db));
    this.run = util.promisify(this.db.run.bind(this.db));
    this.each = util.promisify(this.db.each.bind(this.db));
    this.serialize = util.promisify(this.db.serialize.bind(this.db));
    try {
      console.log("Running database integrity check...");
      const isIntact = this.checkDatabaseIntegrity();

      if (isIntact) {
        console.log("Database integrity passed. No initialization required.");
      } else {
        console.log(
          "Database integrity check failed. Initializing database..."
        );
        this.initializeDatabase();
        console.log("Database initialized successfully.");
      }
    } catch (error) {
      console.error("Error during integrity check or initialization:", error);
      throw new Error(
        "Database integrity validation and initialization failed."
      );
    }
  }

  async checkDatabaseIntegrity() {
    try {
      const result = await this.get(this.integrity_sql);
      if (!result) {
        console.log("No result returned for integrity check query.");
        return false;
      }
      return result["COUNT(*)"] === 16;
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

        (async () => {
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
        })();
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
