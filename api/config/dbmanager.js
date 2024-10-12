const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const util = require("util");
const path = require("path");

class DatabaseManager {
  constructor() {
    this.initializeConfig();
    this.setupDatabase();
    this.initializeDatabase();
  }

  initializeConfig() {
    const configPath = path.join(
      __dirname,
      "../../",
      "api",
      "data",
      "config.json"
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")).config;

    const currentWorkspace = config.workspaces.find(
      (workspace) => workspace.id === config.current.workspace_id
    );

    if (!currentWorkspace) {
      this.defaultWorkspace(config, configPath);
    }

    this.dbPath = decodeURI(currentWorkspace.db);
  }

  defaultWorkspace(config, configPath) {
    console.log("Current workspace not found, defaulting workspace");
    try {
      config.current.workspace_id = 0;
      fs.writeFileSync(configPath, JSON.stringify({ config }, null, 2));
      console.log("Defaulted workspace");
    } catch (error) {
      console.error("Couldn't set default workspace: ", error);
      throw error;
    }
  }

  setupDatabase() {
    this.init_sql = fs.readFileSync(
      path.join(__dirname, "init", "init.sql"),
      "utf8"
    );
    this.integrity_sql = fs.readFileSync(
      path.join(__dirname, "init", "integrity.sql"),
      "utf8"
    );

    if (!fs.existsSync(this.dbPath)) {
      console.log("Database file doesn't exist, creating a new one.");
    }

    this.db = new sqlite3.Database(this.dbPath);
    this.promisifyDbMethods();
  }

  promisifyDbMethods() {
    ["get", "all", "run", "each"].forEach((method) => {
      this[method] = util.promisify(this.db[method].bind(this.db));
    });
    this.serialize = util.promisify(this.db.serialize.bind(this.db));
  }

  async initializeDatabase() {
    try {
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
      console.error("Error during integrity check or initialization:", error);
      throw new Error(
        "Database integrity validation and initialization failed."
      );
    }
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

module.exports = new DatabaseManager();
