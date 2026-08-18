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
import vaultRouter from './routes/vault.js';
import remotesRouter from './routes/remotes.js';
import identityRouter from './routes/identity.js';
import accountsRouter from './routes/accounts.js';
import { authenticate } from './auth/authenticate.js';
import { guard } from './auth/permissions.js';
import { ensureLocalAuthor, hasUsableToken } from './access/primitives/accounts.js';
import { isSwitching } from './vaultSession.js';

/**
 * Every router this API serves, keyed by its mount name under `/api/`.
 *
 * A map rather than seventeen `app.use` lines because that key is used twice: once to build
 * the URL, and once as the lookup into the permission table. Exported so
 * `tests/accounts.test.js` can assert the two never drift — a router added here with no rule
 * in `auth/permissions.js` fails the suite instead of silently resolving to author-only.
 */
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
 */
  constructor(config = {}) {
    this.app = express();

    //Default options
    this.port = config.port || 3000;
    this.logFormat = config.logFormat || "dev";

    //Ip binding options
    this.host = config.host || "localhost";
    this.isLocalhost = config.isLocalhost ?? true;

    // The install's own token. It is no longer a shared secret compared byte-for-byte:
    // start() adopts it as the Author account's token, so a request carrying it resolves
    // to a person with a role like any other. When none is configured (standalone dev
    // without the Electron app, the only process that mints one) an anonymous caller is
    // treated as the Author — see auth/authenticate.js.
    this.apiToken = config.apiToken || null;

    // Refuse to serve anonymous callers even with no token configured. The desktop app
    // never sets this; the headless server entry point (M4) always does, because an open
    // deployment is a very different mistake from an open loopback dev server.
    this.requireAuth = config.requireAuth ?? false;

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
    // Bodies are whole documents and whole sidecars, not small form posts: a
    // metadata write PUTs the entire sidecar (every highlight, card and tag of a
    // book-length document), so body-parser's 100kb default cuts highlighting off
    // once a document accumulates enough of them. 50mb is well above any realistic
    // sidecar or markdown body while still bounding a runaway request.
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

    // Auth guard for everything under /api: resolves the presented token to an account and
    // attaches it as `req.account`, which the role guards below compare against. Browser-
    // initiated loads that can't set headers (PDF/media URLs, <img>/<audio>) pass the token
    // as ?token=.
    this.app.use('/api', authenticate({
      tokenConfigured: !!this.apiToken,
      requireAuth: this.requireAuth,
    }));

    // Vault-switch gate. A switch closes the database and re-points every path resolver;
    // a request served mid-sequence would read a closed handle or, worse, mix the two
    // vaults. This refuses NEW requests for the duration.
    //
    // It used to be able to lean on better-sqlite3 being synchronous, so that no single
    // query could straddle the swap and only the async work (Seal git operations, file IO)
    // needed guarding. The data layer is async now, so that guarantee is gone: a request
    // already in flight can have queued statements on either side of closeDatabase(). The
    // gate still closes the door on new work, which is what keeps a switch bounded, but a
    // request that started before the switch can still fail against a closed handle.
    //
    // Deliberately AFTER the auth guard (an unauthenticated caller learns nothing about
    // vault state) and after /vault's own routes are unreachable — 503 + Retry-After is
    // what tells the renderer to keep polling rather than surface an error.
    this.app.use('/api', (req, res, next) => {
      if (!isSwitching()) return next();
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Vault switch in progress', switching: true });
    });

    // Route mounting.
    //
    // Every router carries a guard('<mount>') in front of it, and the mount name is the key
    // into the one permission table in auth/permissions.js. Keeping the check here rather
    // than inside handlers means the whole access policy is readable in one file, and a
    // router mounted WITHOUT an entry in that table resolves to `author` — it fails closed
    // and loudly instead of quietly serving everyone. tests/accounts.test.js asserts that
    // every name below has a rule.
    for (const [mount, router] of Object.entries(ROUTERS)) {
      this.app.use(`/api/${mount}`, guard(mount), router);
    }

    // 404
    this.app.use((req, res) => {
      res.status(404).json({ code: 404, message: "Url no encontrada" });
    });

    // Global error handler — catches thrown errors and async rejections from all routes
    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      console.error(err);
      // Body-parser rejections carry a status; surfacing them as 500 hides what
      // actually happened (e.g. an oversized sidecar) from the client.
      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large' });
      }
      res.status(500).json({ error: err.message ?? 'Internal server error' });
    });
  }
  /**
   * Provisions the accounts store, then listens.
   *
   * The provisioning lives here rather than in `vaultSession.openVault()` on purpose: the
   * accounts store is scoped to the INSTALL, not to a vault, so it must not be re-derived
   * every time the active vault changes. `start()` is the one path every real boot, every
   * test and any embedder already takes, and it runs exactly once.
   */
  async start() {
    // Adopts this install's `apiToken` as the Author's token, creating the Author from the
    // local identity if the store is new. This is what makes the milestone invisible on a
    // desktop install: the renderer and the MCP server keep presenting the token they
    // already hold, and it keeps working.
    await ensureLocalAuthor(this.apiToken);

    // A served deployment with no way to authenticate is an open deployment. Desktop never
    // sets requireAuth, so this can only fire where it is meant to.
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
