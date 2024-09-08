// Setup.js

const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// Path to the SQLite database
const dbPath = './flashback.db';

// Path to the config SQL file
const configPath = path.join(__dirname, './config/init.sql');

// Check if the database file exists
if (!fs.existsSync(dbPath)) {
  console.log("Database not found, creating a new one...");

  // Create a new SQLite database
  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("Error creating database:", err.message);
    } else {
      console.log("New database created successfully.");
    }
  });

  // Read SQL from the configuration file
  fs.readFile(configPath, 'utf-8', (err, sql) => {
    if (err) {
      console.error("Error reading config SQL file:", err.message);
      return;
    }

    // Execute the SQL statements from the file
    db.exec(sql, (err) => {
      if (err) {
        console.error("Error executing SQL from config file:", err.message);
      } else {
        console.log("Database setup completed using config file.");
      }

      // Close the database connection
      db.close((err) => {
        if (err) {
          console.error("Error closing the database:", err.message);
        } else {
          console.log("Database connection closed.");
        }
      });
    });
  });
} else {
  console.log("Database already exists.");
}
