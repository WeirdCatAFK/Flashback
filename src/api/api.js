/*The idea is that this file manages the api mounting process, so it
 can be called on it's own or as a module on the backend, the spawn.js
 file creates a child process and the main.js file runs it on it's own*/
import express from "express";
import cors from './config/cors.js';
import morgan from "morgan";
class api {
  constructor(config = {}) {
    this.app = express();

    //Default options
    this.port = config.port || 3000;
    this.logFormat = config.logFormat || "dev";

    //Ip binding options
    this.host = config.host || "localhost";
    this.isLocalhost = config.isLocalhost ?? true;

    if (!this.isLocalhost && this.host === "localhost") {
      console.warn(
        "Warning: isLocalhost is false, but host is set to localhost. Binding to all interfaces (0.0.0.0)."
      );
      this.host = "0.0.0.0";
    }
    // Any previous preparing for the workspace should be built here
    // Like db integrity checks or config file checkup

    this.build();
  }
  /*Builds the api as you would normally in express, take into consideration
 that is asynchronousm runs along the constructor*/
  async build() {
    // Middleware mounting
    this.app.use(cors);
    this.app.use(morgan(this.logFormat));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Route mounting
    this.app.get("/", (req, res) => {
      res.status(200).send("Welcome to flashback");
    });

    this.app.use((req, res) => {
      res.status(404).json({ code: 404, message: "Url no encontrada" });
    });
  }
  /*Starts the api after being built*/
  async start() {
    await this.build();
    return new Promise((resolve, reject) => {
      this.server = this.app
        .listen(this.port, () => {
          console.log(`Server is running on port ${this.port}`);
          resolve(this.server);
        })
        .on("error", (err) => {
          console.error("Failed to start server:", err);
          reject(err);
        });
    });
  }
  /*Stops the api after being started */
  async stop() {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            console.error("Error closing server:", err);
            reject(err);
          } else {
            console.log("Server stopped");
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

export default api;
