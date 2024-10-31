import morgan from "morgan";
import express from "express";
import cors from "./config/cors.js";
import integrityCheck from "./config/integrityManager.js";

class FlashbackServer {
  constructor(options = {}) {
    this.app = express();

    this.port = options.port || process.env.PORT || 50500;

    this.logFormat = options.logFormat || 'dev';

    this.initializeMiddleware();
  }

  initializeMiddleware() {
    this.app.use(cors);
    this.app.use(morgan(this.logFormat));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  async initializeRoutes() {
    // Loading modules to ensure integrity before loading anything else that uses the config
    const { default: configRouter } = await import("./routes/config.js");
    const { default: filesRouter } = await import("./routes/files.js");
    const { default: uploadRouter } = await import("./routes/upload.js");
    const { default: pathsRouter } = await import("./routes/paths.js");
    const { default: tagsRouter } = await import("./routes/tags.js");
    const { default: nodesRouter } = await import("./routes/nodes.js");

    this.app.get("/", (req, res) => {
      res.status(200).send("Welcome to flashback");
    });

    this.app.use("/config", configRouter);
    this.app.use("/files", filesRouter);
    this.app.use("/upload", uploadRouter);
    this.app.use("/paths", pathsRouter);
    this.app.use("/tags", tagsRouter);
    this.app.use("/nodes", nodesRouter);

    this.app.use((req, res) => {
      res.status(404).json({ code: 404, message: "Url no encontrada" });
    });
  }

  async start() {
    const configIsUsable = await integrityCheck.checkConfigIntegrity();

    if (!configIsUsable) {
      console.error("Configuration files are not usable. Exiting application.");
      process.exit(1);
    }

    await this.initializeRoutes();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`Server is running on port ${this.port}`);
        resolve(this.server);
      }).on('error', (err) => {
        console.error("Failed to start server:", err);
        reject(err);
      });
    });
  }

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

export default FlashbackServer;

