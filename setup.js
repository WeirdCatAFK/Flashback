const sqlite3 = require("sqlite3");
const fs = require("fs");

// Create new connection
const db = new sqlite3.Database("./flashback.db", (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
    return;
  }

  if (db) {
    console.log("Database connection established.");

    db.get("PRAGMA database_list;", (err, row) => {
      if (err) {
        console.error("Error executing PRAGMA statement:", err.message);
      } else if (!row) {
        console.log("Database is null, running configuration...");

        const config = fs.readFileSync("./config/config.sql", "utf8");
        db.exec(config, (err) => {
          if (err) {
            console.error("Error executing config.sql:", err.message);
          } else {
            console.log("Configuration applied successfully.");
          }
        });``
      } else {
        console.log("Database is not null, configuration not needed.");
      }
    });
  } else {
    console.log("Database is null, running configuration...");

    const config = fs.readFileSync("./config/config.sql", "utf8");
    db.exec(config, (err) => {
      if (err) {
        console.error("Error executing config.sql:", err.message);
      } else {
        console.log("Configuration applied successfully.");
      }
    });
  }
});
