# Flashback Server

A headless Flashback backend: **one vault, several people**, reached over HTTP by desktop
clients that register it as a remote.

It is the same `src/api` the desktop app runs, booted without Electron and with three things
turned on — authentication is mandatory, vault switching is unmounted, and it binds a real
interface instead of loopback. Everything else is the application you already know.

It is **not** a sync service. One person with two machines will use it as one, and that
works, but the model is a shared vault with per-person study progress, not replication.

---

## Quick start

```bash
docker compose up --build
```

On the **first** start the log prints an author token inside a banner:

```
========================================================================
  FLASHBACK SERVER — AUTHOR TOKEN (shown once, not recoverable)

    605ffa20ec8c856b40867ecb25003a96072d95b78642fc51a2972747fb078cc1
  ...
========================================================================
```

Copy it. The accounts store keeps only its SHA-256, so it genuinely cannot be shown again —
if you lose it, mint a new one with `npm run pure-token` (below). Then add the server in the
desktop app as a remote, using that token.

To run it without Docker:

```bash
USER_DATA_PATH=/srv/flashback FLASHBACK_VAULT_NAME=shared npm run server
```

---

## Configuration

Everything is environment variables. They are merged into `config.json` on the volume at
startup, **non-destructively** — a variable you do not set leaves whatever is in the file
alone, so hand-editing `config.json` on the volume is a supported way to configure this and
survives a restart.

| Variable | Default | What it does |
|---|---|---|
| `USER_DATA_PATH` | `/data` in the image | The volume. Everything below lives under it. |
| `FLASHBACK_PORT` | `50500` | Port to listen on. |
| `FLASHBACK_HOST` | `0.0.0.0` | Interface to bind. |
| `FLASHBACK_VAULT_NAME` | existing, else `dreams` | Which vault directory to serve. |
| `FLASHBACK_ALLOWED_ORIGINS` | unchanged | Comma-separated browser origins. See below. |
| `FLASHBACK_LOG_FORMAT` | unchanged | A [morgan](https://github.com/expressjs/morgan) format. `combined` is the usual choice for a server. |
| `FLASHBACK_AUTHOR_TOKEN` | — | Adopt this token as the Author's instead of minting one. |
| `FLASHBACK_USER_NAME` | OS account | Identity new work is stamped with. Must be set with the email. |
| `FLASHBACK_USER_EMAIL` | OS account | — |

**Set the identity before the first start.** Without it, the name is derived from the OS
account — in the container, the `node` user — so documents are created by
`node <node@flashback.local>` and so is every Seal commit, in a git history that outlives the
container. `ensureLocalAuthor()` builds the Author account from it on the *first* run only;
setting it later changes what background work is stamped with but does not rename an Author
who already exists (use `PATCH /api/accounts/:id` for that).

Two settings are forced on and cannot be turned off from the environment, because they are
what distinguishes a server from a dev box:

- **`requireAuth`** — an anonymous caller is refused. On loopback, treating an anonymous
  caller as the Author is a convenience; on a network it is an open door. The server also
  refuses to start if no usable token exists at all.
- **`singleVault`** — `POST /api/vault/switch` and `POST /api/vault/release` return 404. A
  switch closes the database and re-points every path resolver, under every connected user
  at once. `GET /api/vault` (the identity handshake a remote depends on) and `/list` stay.

---

## TLS — not optional

The API authenticates with a bearer token, and browser-initiated loads (PDFs, media,
`<img>`) pass that token as a `?token=` query parameter because they cannot set a header.
**A token sent over plain HTTP across a network is a token you have given away**, and one in
a URL is a token in proxy logs.

So: terminate TLS in front of it. `docker-compose.yml` publishes on `127.0.0.1` by default
precisely so that this is a deliberate step rather than something you forget.

### Caddy

```caddyfile
flashback.example.com {
    reverse_proxy 127.0.0.1:50500
    request_body {
        max_size 60MB
    }
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name flashback.example.com;

    ssl_certificate     /etc/letsencrypt/live/flashback.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/flashback.example.com/privkey.pem;

    # A metadata write PUTs the whole sidecar — every highlight, card and tag of a
    # book-length document. The API accepts 50MB bodies; a proxy that caps at nginx's 1MB
    # default will cut off highlighting on a large document and nothing else.
    client_max_body_size 60M;

    # Reading a PDF or an EPUB streams a large body. The default 60s read timeout is fine
    # for the API but tight for a slow client on a big book.
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:50500;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### `allowedOrigins`

`FLASHBACK_ALLOWED_ORIGINS` is the **browser** allowlist, and only that. Three things are
allowed no matter what you set:

- `"null"` — the packaged desktop renderer is served from `file://`, an opaque origin.
- Any **loopback** origin — enumerating dev ports was worse than treating loopback as one
  trust boundary.
- Anything you list here.

Everything else is refused with `403`, which also stops a non-preflighted cross-origin `POST`
from executing unread.

Requests with **no** `Origin` header pass through untouched. That is not a hole: Node clients
— the MCP server, scripts, the test suite — are not browsers, they cannot be tricked by a
web page into making a request, and they are gated by the token. CORS protects browsers from
other browsers' tabs; the token protects everything.

---

## The volume, and the one backup obligation

Everything the deployment owns is under `USER_DATA_PATH`:

```
/data/
  config.json           server settings (written from the environment at startup)
  accounts.db           WHO may reach this install, and everyone's study schedule
  {vaultName}/
    vault.json          the vault's stable id
    workspace/          the documents themselves — canonical, and a git repo (Seal)
    {vaultName}.db      the derived index
    diary/              per-day study records, its own git repo
```

**Back up `accounts.db`.** It is the one store in the application that cannot be rebuilt from
anything, and it holds two unreconstructible things: the access list (accounts and token
hashes), and **every non-owner's study schedule** (`AccountProgress`). It sits outside every
vault on purpose — so that copying a vault folder to someone else carries no access list with
it — which also means a vault backup does not include it.

The rest degrades gracefully, and it is worth knowing how far:

- `workspace/` is **canonical**. Losing it loses the documents. Back it up.
- `{vaultName}.db` is **derived** — `POST /api/doctor/rebuild` re-derives it from the
  canonical files, and re-projects every non-owner's schedule from `accounts.db`. What a
  rebuild does *not* restore is review **history**: card-health verdicts and FSRS optimizer
  input die with it, for everyone. That has always been true for the owner; the server makes
  it true for more people.

A file-level copy of `/data` while the server is running can catch SQLite mid-write. Stop the
container first (`docker compose stop`, which checkpoints the WAL), or snapshot the volume.

---

## Tokens and roles

Roles are `reader < collaborator < admin < author`:

- **Author** — owns the files. One per install. Recoverable from the terminal.
- **Admin** — works in the vault normally, imports, manages access, sees everyone's progress.
  May grant only Reader, and may not revoke their own token.
- **Collaborator** — annotates documents that already exist. No imports, no new documents.
- **Reader** — study progress only.

Accounts and tokens are managed over `/api/accounts` (see `src/api/API.md`), or from the
terminal against the volume:

```bash
npm run pure-token -- --list   # list accounts and token status; changes nothing
npm run pure-token             # mint a new AUTHOR token, revoking every previous one
```

`pure-token` opens `accounts.db` directly and needs no running API, which is the recovery
path when the author token is lost. In the container:

```bash
docker compose exec flashback npm run pure-token
```

A token takes effect immediately — lookups hit the store per request.

---

## Capacity

Measured with `npm run bench:reviews` (concurrent readers posting `/api/srs/review` over
HTTP): **~260 reviews/second sustained**, which is the saturation ceiling, not a target.

For scale: fifty people studying at a human pace generate roughly 8 reviews/second, about 3%
of that, at a few milliseconds per request. The ceiling starts to matter somewhere around a
thousand people studying simultaneously.

Two structural limits behind that number, worth knowing before you plan around it:

- **One API process per vault.** The canonical layer is the filesystem and the write lock
  (`access/resources/pathLock.js`) is in-process. Running two containers against one volume
  is not supported, and no database change would make it supported.
- **Writes serialize.** `better-sqlite3` is synchronous, so statements block the event loop
  whether or not the adapter queues them. This is the finding that would justify moving to
  a concurrent-write database — and `scripts/bench-reviews.js` is how to prove you need it.

---

## Upgrading

Schema migrations and canonical updates run automatically at startup. Two cautions:

- **Migrations are one-way.** Migration 010 (per-account progress) drops columns an older
  build still reads. Rolling a container image *back* past it will fail loudly against an
  already-migrated vault. See `CHANGELOG.md`.
- Take a volume snapshot before a major upgrade. The migrations are tested, but the vault is
  the only copy of the documents.

---

## What this does not do

- **No password authentication.** Tokens only — no passwords, no reset flow, no email.
- **No vault switching.** One vault per server, by design.
- **No horizontal scaling.** See Capacity.
- **The `user` identity is not authentication.** It is self-asserted, the way
  `git config user.name` is, and the server treats it as exactly that. What authorizes a
  caller is their token.
