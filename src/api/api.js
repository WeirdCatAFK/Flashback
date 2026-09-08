/*The idea is that this file manages the api mounting process, so it
 can be called on it's own or as a module on the backend, the spawn.js
 file creates a child process and the main.js file runs it on it's own*/
import express from "express";
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
import readerRouter from './routes/reader.js';
import progressRouter from './routes/progress.js';
import vaultRouter from './routes/vault.js';
import remotesRouter from './routes/remotes.js';
import identityRouter from './routes/identity.js';
import accountsRouter from './routes/accounts.js';
import { authenticate } from './auth/authenticate.js';
import { guard } from './auth/permissions.js';
import { ensureLocalAuthor, hasUsableToken } from './access/primitives/accounts.js';
import { isSwitching } from './vaultSession.js';

morgan.token('url', (req) =>
    String(req.originalUrl || req.url || '').replace(/([?&]token=)[^&]*/gi, '$1[redacted]'),
);

/** Every router this API serves, keyed by its mount name under `/api/`. */
export const ROUTERS = {
  documents: documentsRouter,
  media: mediaRouter,
  srs: srsRouter,
  subscriptions: subscriptionsRouter,
  seal: sealRouter,
  decks: decksRouter,
  highlights: highlightsRouter,
  categories: categoriesRouter,
  search: searchRouter,
  flashcards: flashcardsRouter,
  doctor: doctorRouter,
  diary: diaryRouter,
  reader: readerRouter,
  progress: progressRouter,
  vault: vaultRouter,
  remotes: remotesRouter,
  identity: identityRouter,
  accounts: accountsRouter,
};

class api {
/**
 * Constructor for the api class.
 *
 * @param {object} config - Configuration options for the api.
 * @param {number} [config.port=3000] - The port number to bind to.
 * @param {string} [config.logFormat="dev"] - The log format to use.
 * @param {string} [config.host="localhost"] - The host to bind to.
 * @param {boolean} [config.isLocalhost=true] - Whether to bind to localhost or all interfaces.
 * @param {() => object|null} [config.updateStatus] - Getter for the headless server's release check. Omitted by the desktop build; the handshake then reports `update: null`.
 */
  constructor(config = {}) {
    this.app = express();

    this.port = config.port ?? 3000;
    this.logFormat = config.logFormat || "dev";

    this.host = config.host || "localhost";
    this.isLocalhost = config.isLocalhost ?? true;

    this.apiToken = config.apiToken || null;

    this.requireAuth = config.requireAuth ?? false;

    this.singleVault = config.singleVault ?? false;

    this.updateStatus = typeof config.updateStatus === "function" ? config.updateStatus : null;

    if (!this.isLocalhost && this.host === "localhost") {
      console.warn(
        "Warning: isLocalhost is false, but host is set to localhost. Binding to all interfaces (0.0.0.0)."
      );
      this.host = "0.0.0.0";
    }

    this.build();
  }
  /** Builds the Express app: middleware, guards and every router. */
  async build() {
    this.app.locals.updateStatus = this.updateStatus;

    // @ts-ignore — cors is a valid RequestHandler, TypeScript infers it too broadly
    this.app.use(cors);
    this.app.use(morgan(this.logFormat));
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    this.app.get("/", (req, res) => {
      res.status(200).send("Welcome to flashback");
    });

    this.app.get("/embed/youtube", (req, res) => {
      const videoId = String(req.query.v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(renderYoutubeEmbed(videoId));
    });

    this.app.use('/api', authenticate({
      tokenConfigured: !!this.apiToken,
      requireAuth: this.requireAuth,
    }));

    this.app.use('/api', (req, res, next) => {
      if (!isSwitching()) return next();
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Vault switch in progress', switching: true });
    });

    if (this.singleVault) {
      this.app.use('/api/vault', (req, res, next) => {
        if (req.method === 'POST' && (req.path === '/switch' || req.path === '/release')) {
          return res.status(404).json({ code: 404, message: "Url no encontrada" });
        }
        next();
      });
    }

    for (const [mount, router] of Object.entries(ROUTERS)) {
      this.app.use(`/api/${mount}`, guard(mount), router);
    }

    this.app.use((req, res) => {
      res.status(404).json({ code: 404, message: "Url no encontrada" });
    });

    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      console.error(err);
      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large' });
      }
      if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
        const body = { error: err.message };
        if (err.code) body.code = err.code;
        if (err.etag !== undefined) body.etag = err.etag;
        return res.status(err.status).json(body);
      }
      res.status(500).json({ error: err.message ?? 'Internal server error' });
    });
  }
  /** Provisions the accounts store, then listens. */
  async start() {
    await ensureLocalAuthor(this.apiToken);

    if (this.requireAuth && !(await hasUsableToken())) {
      throw new Error(
        'requireAuth is set but no usable token exists. Mint one with `npm run pure-token` before starting.',
      );
    }

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
  /** Stops listening and releases the port. */
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

function renderYoutubeEmbed(videoId) {
  const safeId = JSON.stringify(videoId);
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
        onReady: function(){ post({ event: 'ready' }); startProgress(); },
        onError: function(e){ post({ event: 'error', code: e && e.data }); }
      }
    });
  };
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'fb-yt-cmd' || !player) return;
    try {
      if (d.cmd === 'seek') { player.seekTo(d.seconds, true); if (player.playVideo) player.playVideo(); }
      else if (d.cmd === 'seekQuiet') { player.seekTo(d.seconds, true); }
      else if (d.cmd === 'mark') { post({ event: 'markAt', seconds: (player.getCurrentTime && player.getCurrentTime()) || 0 }); }
    } catch (e) {}
  });
  // Where the viewer has watched to. Only while actually playing: a paused video parked
  // on one frame is not someone watching, and reporting it would keep rewriting the same
  // position for as long as the tab stayed open.
  function startProgress(){
    setInterval(function(){
      try {
        if (!player || !player.getPlayerState || player.getPlayerState() !== 1) return;
        var seconds = (player.getCurrentTime && player.getCurrentTime()) || 0;
        var duration = (player.getDuration && player.getDuration()) || 0;
        post({ event: 'progressAt', seconds: seconds, duration: duration });
      } catch (e) {}
    }, 5000);
  }

  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
</script>
</body>
</html>`;
}

export default api;
