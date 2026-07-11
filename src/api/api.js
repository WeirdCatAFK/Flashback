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
import diaryRouter from './routes/diary.js';

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

    // YouTube embed proxy. The renderer is served from file:// in the packaged app,
    // which has an opaque origin and sends no Referer — and since late 2025 YouTube
    // rejects such embeds with "Error 153 (video player configuration error)". This
    // page is served over the real http://localhost origin, so the embedded player
    // gets a valid origin/referrer and authorizes. It carries no vault data, so it
    // sits OUTSIDE the /api token guard (keeping the token out of the iframe URL and
    // the Referer YouTube sees). The renderer iframes it and drives it via postMessage.
    this.app.get("/embed/youtube", (req, res) => {
      const videoId = String(req.query.v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(renderYoutubeEmbed(videoId));
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
    this.app.use('/api/diary', diaryRouter);

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

// Standalone embed shell served by GET /embed/youtube. Runs the YouTube IFrame
// API from this page's real http://localhost origin (so the late-2025 referrer/
// origin check passes) and bridges the minimal control surface the renderer needs
// over postMessage: parent → { cmd: 'seek'|'mark' }, iframe → { event: 'ready'|
// 'error'|'markAt' }. Uses youtube-nocookie + strict-origin-when-cross-origin, the
// combination YouTube documents for embeds. `videoId` is pre-sanitized by the route.
function renderYoutubeEmbed(videoId) {
  const safeId = JSON.stringify(videoId); // already ^[A-Za-z0-9_-]$ filtered; quote for JS
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}#player{width:100%;height:100%}</style>
</head>
<body>
<div id="player"></div>
<script>
  var VIDEO_ID = ${safeId};
  var player = null;
  function post(msg){ try { parent.postMessage(Object.assign({ type: 'fb-yt' }, msg), '*'); } catch (e) {} }
  window.onYouTubeIframeAPIReady = function(){
    player = new YT.Player('player', {
      videoId: VIDEO_ID,
      host: 'https://www.youtube-nocookie.com',
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: function(){ post({ event: 'ready' }); },
        onError: function(e){ post({ event: 'error', code: e && e.data }); }
      }
    });
  };
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'fb-yt-cmd' || !player) return;
    try {
      if (d.cmd === 'seek') { player.seekTo(d.seconds, true); if (player.playVideo) player.playVideo(); }
      else if (d.cmd === 'mark') { post({ event: 'markAt', seconds: (player.getCurrentTime && player.getCurrentTime()) || 0 }); }
    } catch (e) {}
  });
  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
</script>
</body>
</html>`;
}

export default api;
