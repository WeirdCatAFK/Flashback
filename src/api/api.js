/*The idea is that this file manages the api mounting process, so it
 can be called on it's own or as a module on the backend, the spawn.js
 file creates a child process and the main.js file runs it on it's own*/
import express from "express";
import crypto from "crypto";
import cors from './config/cors.js';
import morgan from "morgan";
import documentsRouter from './routes/documents.js';
import mediaRouter from './routes/media.js';
import srsRouter from './routes/srs.js';
import subscriptionsRouter from './routes/subscriptions.js';
import sealRouter from './routes/seal.js';
import decksRouter from './routes/decks.js';
import highlightsRouter from './routes/highlights.js';
import categoriesRouter from './routes/categories.js';
import searchRouter from './routes/search.js';
import flashcardsRouter from './routes/flashcards.js';
import doctorRouter from './routes/doctor.js';

class api {
/**
 * Constructor for the api class.
 * 
 * @param {object} config - Configuration options for the api.
 * @param {number} [config.port=3000] - The port number to bind to.
 * @param {string} [config.logFormat="dev"] - The log format to use.
 * @param {string} [config.host="localhost"] - The host to bind to.
 * @param {boolean} [config.isLocalhost=true] - Whether to bind to localhost or all interfaces.
 */
  constructor(config = {}) {
    this.app = express();

    //Default options
    this.port = config.port || 3000;
    this.logFormat = config.logFormat || "dev";

    //Ip binding options
    this.host = config.host || "localhost";
    this.isLocalhost = config.isLocalhost ?? true;

    // Bearer/query-param token guarding every /api route. When no token is
    // configured (standalone dev without the Electron app, which is the only
    // process that mints one) auth is disabled — the packaged app always has a
    // token, so production is always guarded.
    this.apiToken = config.apiToken || null;

    if (!this.isLocalhost && this.host === "localhost") {
      console.warn(
        "Warning: isLocalhost is false, but host is set to localhost. Binding to all interfaces (0.0.0.0)."
      );
      this.host = "0.0.0.0";
    }

    this.build();
  }
  /*Builds the api as you would normally in express, take into consideration
 that is asynchronous and runs along the constructor*/
  async build() {
    // Middleware mounting
    // @ts-ignore — cors is a valid RequestHandler, TypeScript infers it too broadly
    this.app.use(cors);
    this.app.use(morgan(this.logFormat));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Readiness ping — stays open (unauthenticated) so the renderer can gate on it
    // before it has fetched the token, and health checks don't need credentials.
    this.app.get("/", (req, res) => {
      res.status(200).send("Welcome to flashback");
    });

    // Auth guard for everything under /api. Browser-initiated loads that can't
    // set headers (PDF/media URLs, <img>/<audio>) pass the token as ?token=.
    this.app.use('/api', (req, res, next) => this.authenticate(req, res, next));

    // Route mounting
    this.app.use('/api/documents', documentsRouter);
    this.app.use('/api/media', mediaRouter);
    this.app.use('/api/srs', srsRouter);
    this.app.use('/api/subscriptions', subscriptionsRouter);
    this.app.use('/api/seal', sealRouter);
    this.app.use('/api/decks', decksRouter);
    this.app.use('/api/highlights', highlightsRouter);
    this.app.use('/api/categories', categoriesRouter);
    this.app.use('/api/search', searchRouter);
    this.app.use('/api/flashcards', flashcardsRouter);
    this.app.use('/api/doctor', doctorRouter);

    // 404
    this.app.use((req, res) => {
      res.status(404).json({ code: 404, message: "Url no encontrada" });
    });

    // Global error handler — catches thrown errors and async rejections from all routes
    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      console.error(err);
      res.status(500).json({ error: err.message ?? 'Internal server error' });
    });
  }
  /* Express middleware: rejects any /api request without a valid token.
     Accepts `Authorization: Bearer <token>` or a `?token=` query param.
     No-ops when no token is configured (see constructor). */
  authenticate(req, res, next) {
    if (!this.apiToken) return next();
    const provided = this._extractToken(req);
    if (provided && this._tokenMatches(provided)) return next();
    return res.status(401).json({ error: 'Unauthorized: missing or invalid API token' });
  }

  _extractToken(req) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    if (typeof req.query.token === 'string') return req.query.token;
    return null;
  }

  // Constant-time comparison so a caller can't probe the token byte-by-byte.
  _tokenMatches(provided) {
    const a = Buffer.from(provided);
    const b = Buffer.from(this.apiToken);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /*Starts the api after being built*/
  async start() {
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
            resolve(undefined);
          }
        });
      } else {
        resolve(undefined);
      }
    });
  }
}

export default api;
