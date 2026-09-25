# Changelog

## Unreleased

### Changed — Tactile Learner: themes, fonts and the tab bar

The interface is moving to a new design language, one area at a time. In this release:

- **Every dark theme comes in two variants.** *Focus* keeps the card a step darker than the
  desk; *Lamp* makes it a step lighter. Pick them in Config → Theme. The theme called "Focus
  blue" is now listed as "Calm blue". Existing theme choices carry over unchanged.
- **Fonts are bundled** with the app instead of downloaded at start-up, so they render offline,
  and numbers, paths and small labels now use Geist Mono.
- **The tab bar follows the way you work:** make (Documents, Flashcards, Decks), study
  (Trainer), look back (Statistics, Diary, Graph), keep (Seal, Metadata). Graph moved down to
  sit with the look-back screens. Hovering a tab tells you what it is for and its shortcut.
- **Quieter where it should be.** Paths, counts, shortcuts and other small labels are a shade
  lighter than the text beside them, dividers inside a page are softer than the edges of a
  panel, no corner is rounder than a card's, and the document page is the brightest surface
  in the window.
- **Icons are quieter and easier to tell apart.** The tab bar's and the file tree's icons are
  solid shapes in a muted tone instead of outlines, and each has a shape of its own: a stamp
  for Seal, an open book for the Diary, a globe for a web clip, stacked pages for a PDF.
- **The zoom shows while you use it.** After Ctrl+plus or Ctrl+minus, the title bar shows the
  zoom (for example 110%); click it, or press Ctrl+0, to go back to 100%.
- **Ctrl+1 to Ctrl+9 open the tabs** in that order, and Ctrl+, opens Config. They can be
  rebound in Config like the Trainer's keys. A Trainer key such as `1` no longer fires when
  pressed together with Ctrl or Alt.
- **Renamed:** Manage is now **Metadata**, and the Server tab (on a remote) is **Server
  Management**. The title bar now shows the screen you are on.
- **The card is a real card.** It follows the theme (paper in the light theme, a darker or
  lighter card in the dark ones), keeps an index card's 5 × 3 shape, and carries nothing but its
  content — its source is cited at the foot of the answer side.
- **The Trainer** has one top bar: what to study, folded into a single button with a panel for
  Study and Leave out; the session's settings (Per session, New cards, Only what I've read) in
  view as steppers; and the count and streak. The progress bar spans the window.
- **Per session** splits a long queue into batches (5 to 100, or All). A batch ends once every
  card in it has been remembered; the end says what happened and offers the next batch or a
  line in your diary.
- **After each grade** the card shows the grade and how the gap to its next review changed
  ("4 d → 8 d"), for every scheduler, and the next card waits a moment so you can read it.
  `POST /api/srs/review` now returns that `interval`.
- **Each grade button says when that grade brings the card back** ("Good · in 8 days"). For
  FSRS, `GET /api/srs/due` returns the preview (`preview`, optional `retention` parameter).
- **The card grows with the window** and sits just above the grade buttons.
- **Flashcards is a catalogue.** A large search comes first; on the left, your cards' sources
  are drawn like the file tree (documents, then Cards, the default deck), each with a count and
  a thin line for how much of it you hold long-term. Below them, cards are sorted by the **gap
  between reviews** — New, 1 day, up to a week, up to 3 weeks, up to 2 months, longer — which
  works the same for every scheduler and replaces the Levels chart; then Health (flagged,
  overloaded, productive). The list can be ordered by next review, source, A to Z or newest,
  and grouped by gap or source. Each row says where the card comes from and when it is next
  due; Ctrl+F jumps to the search.
- **One card editor.** Clicking a card opens it in a card editor that floats over the screen,
  with the type picker, the fields and a live preview side by side; a blank card previews a
  worked example of its type. Deleting a card confirms in place. The same editor makes new
  cards on Flashcards and Decks, and appears in the card details.
- **Decks are boxes.** Each deck is drawn as a box of cards in its own colour, with what is
  due and how much is held long-term; the default deck is the kraft one. A deck's page shows
  its box, lets you rename it and edit its description in place, recolour it, and add cards
  from a finder over the page. "New deck" makes the deck at once and opens it, ready to name.
  A deck's colour is stored in its `_decks/<uuid>.json` (`color`); decks made before this show
  a colour picked from their id.
- **Deck covers.** A deck's page can carry a banner, like a Notion cover: upload an image, or
  pick one of the patterns drawn in the deck's colour. Drag an image to choose which part
  shows. Images are kept in `workspace/_decks/covers/`, versioned by Seal with the deck; the
  new routes are `GET`/`POST`/`PUT`/`DELETE /api/decks/:hash/cover`. `GET /api/decks` and `GET /api/decks/:hash` now return
  `color` and `standing`, and `PUT /api/decks/:hash` accepts `color`.
- **YouTube videos read like documents.** Once a video's captions are fetched, the transcript
  is the text under the player: paragraphs with their time in the margin (click to play from
  there), highlights, cards beside the passage, and Find, as in a note. A card made from it
  cites the line and its time. Without captions, the moments you mark are notes: press M (or
  Mark moment above the page) and write what is happening while the video plays. A bar under
  the player stays in view with play, the position and your moments; the passage being said
  is marked as it plays. Scroll away while it plays and the video floats small in a corner of
  your choice: drag it to another corner and it stays there next time. The old marker list
  and the Show transcript button are gone. The embed page the API serves gains play, pause
  and a clock; an older server still plays, with a slower clock.
- **Click a highlight to change it.** A toolbar opens over it with its colour marked: pick
  another colour, make a card from the passage, or remove it (asking first when cards hang off
  it). Works in notes, text, web clips, PDFs and EPUBs.
- **Documents: the file tree.** It can be hidden entirely — the first button in the tab bar,
  or choosing the Documents icon again — and the document then moves left into the space it
  leaves and widens into it (up to a comfortable line length), in every format. The tree slides out when you rest the pointer in the space left of
  the text. Resizing it snaps to a few set widths. Its four header buttons are
  one "+" menu. Each document shows its name without the extension, its card count as a small
  card outline and a number, and a thin line under the name for how far you have read it. The
  icons are redrawn in one monoline set, told apart by shape; they can be turned off in Config →
  Appearance.
- **Documents: the head, the reading strip and Find.** Every document opens with a head that
  scrolls away with it — the folder path, the title and the tags, which you now add and remove
  right there — and can carry a cover like a deck's (`POST`/`PUT`/`DELETE
  /api/documents/cover`). The reading strip (Set mark here, Mark finished, Clear, Go to start)
  sits under the tabs for every format, PDF, EPUB and YouTube included, with a full-width line
  for how far you have read. The Inspector column is gone: Ctrl+F (or Find) opens a searchable
  index of the document's cards and highlights over it, in reading order with each passage's
  cards together. Hovering a row makes its passage glow in the text and lifts its cards in the
  margin; choosing one jumps to the passage, which glows as you land. Cards are written and edited in the card editor over the document. Removing a
  highlight that has cards asks in place, in the toolbar or the row, instead of in a dialog.
- **Documents: cards in the margin**, in notes, text, web clips, PDFs and EPUBs. A document's cards sit beside their passage: a passage
  with one card shows the card (click to turn it over, Edit to change it), a passage with
  several shows them in a kraft box you pull them out of, and a highlight with no card shows a
  short mark. Hovering a card lights its passage (except in an EPUB, where only the card
  lifts). The column appears when the window is wide enough.
- **EPUBs scroll.** A book now flows down the page like a note instead of turning pages, so its
  head scrolls away above it. PDF zoom, Fit width and Box highlight, and an EPUB's text size, now
  sit in the reading strip rather than in a toolbar of their own.
- **Statistics is a short report.** One column, read top to bottom: how complete the vault
  is (read and known), what is coming, whether it is staying, where the cards are (the same
  gap bands as Flashcards; click one to see those cards), and your reviews.
- **The Diary puts the writing first.** A month calendar shows how busy each day was and marks
  the days you wrote on, with the month's entries listed by their first line beneath it. The
  chosen day reads like a journal page: one sentence summing it up, your reflection (written in
  place; Ctrl+S saves, Esc cancels), then the day in detail.
- **Metadata: categories on priority levels.** Several categories can share a level, and the
  Trainer studies level 1 first. Drag a category to another level, or onto "new level" above
  or below the rest; Raise and Lower (Alt+↑/↓) do the same from the keyboard. Deleting one
  says how many cards lose it, and the cards stay.
- **Metadata: tags with their reach.** Each tag shows where it is applied (folders, documents,
  decks) and how many cards carry it. Rename one or remove it everywhere at once, or click it
  to see its cards in Flashcards. A category opens its cards the same way.
- **Seal: History and Health.** History reads like the Diary: seals grouped by day, one
  sentence each, with a run of highlight and card edits to one document folded into a single
  line. Restore asks right under the entry, saying what goes back and what does not. Health
  holds the maintenance: files changed outside Flashback, and checking, syncing or rebuilding
  the index (a rebuild now asks you to type `rebuild`).
- **Config is short sections.** An index on the left (Study, Appearance, Keyboard, You, AI
  assistant, Local server, About) sums each section up in a line, and "Search settings"
  (Ctrl+F) finds any setting by name. Themes are chosen from swatches drawn in their own
  colours; the zoom can be set there too. The theme editor opens as its own page. Every
  shortcut, including the ones that can't be changed, is listed under Keyboard.
- **The Graph's panels are solid**, like the app's other floating panels, instead of frosted
  glass. The Graph panel slides shut to its header instead of vanishing, and a selected
  node's name no longer breaks mid-word.
- **For the API:** `GET /api/decks/cards` gains `band`, `algorithm`, `source`/`sourcePath`,
  `tag`, `category`, `groupBy` and the `front`, `source`, `created`, `gap` and `due` orders,
  returns each card's `gap`, and allows up to 500 rows; `GET /api/decks/cards/summary` is new.
  `GET /api/documents/tags/overview` and `POST /api/documents/tags/rename` are new;
  `GET /api/categories` rows carry `cards`, and `DELETE /api/categories/:id?clear=1` deletes
  a category in use, clearing it from its cards. `GET /api/srs/statistics` carries `bands`, and
  `GET /api/diary` items carry `reviews` and `firstLine` (the latter withheld from an MCP
  client unless diary access is full).

### Fixed — renaming a category left its cards behind

A card names its category in its own file. Renaming a category changed the name in the list
and nowhere else, so every card kept the old name, and the next Vault Doctor run brought the
old category back ("Recovered by Vault Doctor") and moved the cards onto it. A rename now
rewrites every card that uses the category, and renaming onto a name another category already
has is refused.

### Fixed — a card lost its document's tags in the index

Saving a document inside a folder, and every index rebuild, handed that document's cards only
the folder's tags, dropping the document's own. The files were always right; the index was
not, so filtering or studying by such a tag missed those cards. Each save now repairs the
document it touches, and a rebuild (Seal → Health) repairs the whole vault.

### Fixed — a second session on the same day never reached the Diary

Studying twice in one day left the Diary showing the first session until you ran "Rebuild
from history". The page loaded a day's summary once and kept it, and the summary file was
only rewritten when a session was recorded — and even then it could be written a moment
before the session's last review was saved. The Diary now recalculates today from the whole
day's review history every time you open it, the Trainer waits for the last review before
recording, and an unchanged day is no longer re-committed to the diary's history.

### Added — a published server image, and a server that knows when it is behind

`docs/SERVER.md` has always told operators that upgrading is `docker compose pull` and that
rolling back is pinning the previous tag. Neither was true: CI built the container and threw it
away, so there was no image to pull and no tag to pin.

Every tagged release now publishes one to GitHub Container Registry:

```
ghcr.io/weirdcatafk/flashback-server:<version>
ghcr.io/weirdcatafk/flashback-server:latest
```

It is the same image CI booted — started on a real volume, checked for readiness, checked that
an anonymous `/api` call is refused, checked that it shuts down cleanly — retagged and pushed,
never rebuilt. Nothing reaches the registry that did not start. `linux/amd64` only for now: an
arm64 image cannot be booted on the x64 runner, and shipping one untested would give up the
point of the exercise.

Pin a version with `FLASHBACK_VERSION` in `.env`, which is what makes a rollback possible —
subject to the standing caution that migrations are one-way.

The server also asks GitHub once at boot and once a day whether a newer release exists, and says
so in the log and on the `/api/vault` handshake, where a connected desktop client shows it in the
**Server** tab. It downloads nothing and restarts nothing: this process holds the only copy of
the workspace, and when to upgrade is yours to decide. `FLASHBACK_UPDATE_CHECK=off` disables the
request entirely.

### Fixed — `.env` did nothing under Docker Compose

Cloning the repository, copying `.env.example` to `.env` and running `docker compose up --build`
ran the hardcoded defaults and gave no hint why. Compose reads `./.env` for *substitution*, and
every value in `docker-compose.yml` was a literal with nothing to substitute into.

Every setting is now `${NAME:-default}`, so a `.env` beside `docker-compose.yml` configures the
deployment — including the published port, which `env_file:` could never have reached. Precedence,
top wins: your shell's environment, then `.env`, then the defaults in the compose file, then
`/data/.env` inside the container. Two Compose-only variables come with it: `FLASHBACK_VERSION`
(which image tag to run) and `FLASHBACK_BIND_ADDR` (the host interface the port is published on,
still loopback by default, so exposing the server stays a deliberate act).

### Added — Flashback Server for Windows

The headless server was published for Linux only. Every release now also carries two Windows
builds, attached to the same GitHub Release as the desktop installers:
`flashback-server-<version>-win32-x64.zip` needs Node 22 on PATH, and
`…-win32-x64-standalone.zip` embeds `node.exe` and needs nothing installed at all. Both are
built and smoke-tested on a Windows runner — booted through their `.cmd` launcher, with the
API, PDF extraction and EPUB extraction exercised against the real artifact.

One caveat worth knowing before you run one as a service: Windows has no signals. `Ctrl+C` in
the console shuts down cleanly, but `taskkill` and every service wrapper terminate the process
outright, so the WAL is not checkpointed. Nothing is lost — SQLite replays it on the next
start, and CI asserts that it does — but Docker remains the recommended deployment.

### Fixed — tags typed on a standalone card went nowhere

A card made outside a document — the "New standalone card" button, or an AI assistant
calling `create_flashcard` with no `path` — showed a tag field, accepted what you typed,
and dropped it. Not silently in one place: every layer under the form discarded the field,
so the tag never reached the card, the tag list, the graph, or a search.

Those tags are now the card's own, kept in the system deck's canonical file and restored by a
Vault Doctor rebuild like the rest of it. A standalone card can be found by tag, studied by
tag, and retagged from the card view, which now shows the tags a card actually has rather
than hiding the field. Nothing about document-anchored cards changed — theirs always
worked, and still live in the document's sidecar.

### Fixed — one server, one remote

Adding a Flashback Server you had already added replaced the existing entry, credential and
all. That made it impossible to hold two accounts on one server — an author token and a
collaborator token, say — which is exactly what you need to see what a role actually looks
like. Entries are now told apart by name as well as address: give the same server a second
name to connect as a second account. Re-adding under the same name still replaces, which is
how you refresh an expired token.

### Fixed — `0.0.0.0` accepted as a server address

The server printed the interface it bound to (`0.0.0.0:50501`) as though it were an address
to connect to, and the client accepted it: the handshake runs in Electron's main process,
where Node resolves the unspecified address, so it passed. The renderer is Chromium, which
refuses it — so the app switched to a server it could never reach and sat on the loading
screen with the role showing as unknown.

The server now prints what to connect to, and a bind address is refused when adding a remote
and when connecting to one — so a remote saved before this is caught too, rather than
switched to.

### Fixed — stuck on a server you cannot leave

Connecting to a Flashback Server that turned out to be misconfigured, or that stopped
answering afterwards, left the app with no way back to a local vault. Choosing one from the
title bar or the vault manager appeared to do nothing: the local API really did open the vault
you picked, but the app stayed pointed at the remote, so nothing on screen changed. Restarting
the app was the only way out.

Opening a local vault now also leaves the remote, which is what it always looked like it did.
Returning to the vault the app already had open is a pure re-point that does no database work
and cannot fail — so getting home works even when other things do not.

### Roles in the app

Connecting to a server as a Reader used to look exactly like being the Author: every
"New document", "Delete", "Rollback" and "Rebuild" button was there, and each one produced a
403 when pressed. The app now shows what your role can actually do.

- **A role badge in the title bar**, beside the vault name — shown only on a remote, because on
  your own vault there is nobody to be distinguished from. It is the answer to "why is there no
  New Document button?" before anyone has to go looking.
- **Controls follow the role.** Creating, importing, deleting, moving, rolling back and
  rebuilding disappear for those who cannot do them; controls that sit beside something you
  *can* do are disabled with a tooltip naming the role required. Lists that are still worth
  reading — a document's tags, a deck's tags, the card categories — stay visible and go
  read-only rather than vanishing. Navigation never changes: a Reader keeps Documents, Trainer,
  Stats and Logs.
- **A new Server tab**, on a remote only: which server this is, which vault, its versions, and
  who you are on it. Admins also get the people table — create an account, change a role, issue
  or revoke a token, and see each person's study progress — and the Author gets pure-token
  rotation.
- Markdown and text documents are **read-only without the Admin role**, and so is highlighting
  them. Their highlights live in the body as marks in the prose, so annotating one rewrites the
  whole file. A PDF's or an EPUB's highlights live in the sidecar and are open to Collaborators
  as before.
- **The Diary is called Logs on a server, and stays the Diary on your own vault.** Only the
  name changes with it — the route, the directory and your opt-in are untouched either way. On
  a server it now says plainly that one shared history holds every studier's entries and that
  an administrator can read yours; on a local vault, where both the warning and the rename
  would be false, it is the Diary you have always had.

The desktop app is unchanged: a local vault resolves to the Author and every control behaves
exactly as before.

Two fixes found while verifying this against a real server: `POST /api/accounts` answered
**403 for a malformed role** where it should have answered 400 — telling a client it lacked a
permission when its payload was simply wrong — and the packaged renderer's capability map is
now pinned to the API's permission table by a test, so a control can no longer drift into
offering what the server would refuse.

### Flashback Server (new)

Flashback can now run headless: one vault, several people, reached over HTTP by desktop
clients that register it as a remote. It is the same backend the desktop app runs — not a
fork — with authentication made mandatory and vault switching removed.

- **`npm run server`**, plus a `Dockerfile` and `docker-compose.yml`. Configured entirely by
  environment variables, merged non-destructively into the vault's `config.json`, so
  hand-editing that file on a mounted volume keeps working.
- On a fresh volume it bootstraps itself: creates the config, builds the vault, and prints an
  **author token once**. Supply your own with `FLASHBACK_AUTHOR_TOKEN` instead if you prefer.
- **Anonymous callers are refused.** On the desktop, a request with no token is treated as the
  Author — a convenience that is an open door on a network. The server also refuses to start
  when no usable token exists at all.
- `POST /api/vault/switch` and `/release` return **404** on a server build. One vault per
  server; a switch would close the database under every connected user at once.
- `SIGTERM` shuts down cleanly — stop accepting, flush Seal's pending commits, checkpoint the
  WAL — so a container restart does not lose recent writes.
- Deployment, TLS, CORS and the backup obligation are documented in **`docs/SERVER.md`**.

Nothing here changes the desktop app. Both switches are off unless the server entry point
sets them, and the full suite passes unchanged.

### Faster reviews on a shared vault

Two pieces of work a reader's review was doing and then throwing away:

- It read the **entire `.flashback` sidecar** off disk and parsed it, to validate a card that
  the database had already resolved. That was ~40% of the cost of the request.
- It recomputed and rewrote the document's **presence** score and every ancestor folder's —
  a second whole-database transaction — to store the value it had just read. Presence is the
  owner's number about the document; a reader's grade cannot move it.

Measured end to end over HTTP, sustained review throughput went from **166/sec to 262/sec**
(+58%), and requests stopped failing outright under 200 concurrent studiers. Single-user
desktop use is unaffected in behaviour and slightly faster.

### Standalone server zip

`npm run package:server` builds a self-contained Flashback Server: one bundled, minified ESM
file plus the three packages that resolve their own files at runtime. **7.8 MB zipped**, or
about 35 MB with the Node runtime embedded (`npm run package:server:standalone`), against
365 MB for the container image.

A single executable is not available: Node's SEA feature runs the embedded entry point as
CommonJS only, and the server needs top-level await. esbuild's ESM output has no such limit,
which is what makes the bundle possible at all.

Artifacts are platform-specific because `better-sqlite3` is a compiled addon, and the build
refuses to package one that the current Node cannot load — which is what stops a zip built
straight after `npm run dist:win` (where the addon is compiled for Electron) from shipping
broken.

### Smaller builds

`dependencies` had accumulated the whole frontend. React, tiptap, epubjs, katex, the remark
and prosemirror trees — all of it is bundled by Vite into `dist-react/` at build time, and
none of it is imported at runtime by anything. It was nevertheless being installed into both
shipped products.

Walking the import graph from each entry point gave the real answer: 17 packages are reachable
outside Electron (13 server, 2 MCP, 2 Electron main). The other 16 moved to `devDependencies`,
`nodemon` with them, and `npm` — 19 MB that nothing imported — was dropped outright.

- Windows app bundle (`app.asar`): **142.8 MB → 86.1 MB** (−40%)
- Server container image: **435 MB → 365 MB**

When adding a package, keep the split: a frontend dependency filed under `dependencies` ships
in the installer and the container without ever being loaded.

### Fixed

- **The packaged app could not start.** `electron-builder.json` did not include `src/shared`,
  which `access/primitives/config.js` imports — the module every other module loads first.
  Verified against a real build: `config.js` was in the bundle and the file it imports was
  "not found in this archive". Broken since `src/shared/` was introduced, and invisible
  because development runs from source rather than from a bundle.
- `port: 0` — "let the OS choose a free port" — was silently turned into port 3000, so two
  API instances in one process collided and the test suite always bound 3000 whether it was
  free or not.
- The `GET /api/vault` handshake reported `appVersion: null` when the API ran from a bundle,
  because the version was read from a path relative to the route module. That field is half
  the compatibility contract a client checks.

### Per-user spaced repetition

A vault can now be studied by more than one person without them grading each other's cards.

- Every schedule, review log, card-health verdict and fitted FSRS weight vector belongs to an
  **account**. Two people reviewing the same card diverge; neither one's grade moves the
  other's due list, retention numbers or streak.
- The owner's progress stays canonical in the `.flashback` sidecar exactly as before. Everyone
  else's lives in `accounts.db`, outside the vault, so a copied vault folder carries documents
  and the owner's history — never somebody else's study record and never an access list.
- A non-owner's review therefore **writes no file and produces no Seal commit**. Reading is not
  editing.
- `POST /api/srs/optimize` is now reader-level rather than admin-level. Fitted FSRS weights
  model one individual's forgetting curve and are stored per account, so refitting them changes
  nothing anyone else can see.
- The diary is per account: the owner keeps `diary/summaries` and `diary/entries` untouched,
  everyone else gets `diary/accounts/<accountId>/`. **One git repo still covers all of it**, so
  on a shared vault the diary is not a private local diary — treat it as a shared study log.

**On a single-user desktop install nothing above is visible.** There is one account, it is the
Author, and it may do everything — which is how Flashback has always behaved.

### Concurrent editing

Groundwork for a shared vault, and a real improvement on a single desktop too — two windows on
one document used to overwrite each other silently.

- A save that lost a race is now **refused rather than applied**. The editor keeps your draft
  and offers **Reload** (take what is on disk) or **Overwrite** (yours wins). Nothing is
  resolved automatically, because only the person who typed it knows which version matters.
- Editing different cards of the same document no longer collides. Card and highlight edits are
  applied by the server to the entity you named, so only two edits to the *same* card conflict.
- **Content edits are committed to Seal immediately**, in the order the requests arrived,
  instead of two seconds later. Grading cards still collapses into one commit per study
  session — that is the one write whose history nobody rolls back to. Authoring several cards
  in a row now produces one commit each, so you can roll back to any of them.

### Fixed

- The diary got slow enough to look broken. Migration 010 indexed `ReviewLogs.account_id` on
  its own; because every row of a one-person vault matches it, SQLite took that index and
  abandoned a good join order. A day's summary went from ~120ms to ~4s, and **Rebuild from
  history** — one summary per active day, in a single request — went from about two seconds to
  minutes, which reads as a hang. The index is now `(account_id, flashcard_id)` and the same
  work is faster than it was before per-account progress existed.
- Migrations 001 and 004 could put back the `Flashcards` SRS columns that migration 010
  removes. Their guards asked whether the old columns were missing, which stopped meaning
  "not built yet" and started meaning "deliberately dropped" — so on the second launch after
  upgrading, six empty `fsrs_*` columns reappeared beside the real values in `CardProgress`.
  Nothing read them and no schedule was affected, but a stale column that still reads is the
  exact failure the move was made to prevent. Both guards now test for the newer state, and
  migration 011 removes the columns from any vault that already acquired them.
- Startup no longer races its own schema work. `validate()` had become async without its callers
  awaiting it, so migrations could still be running when the first query arrived; a migration
  that threw surfaced as an unhandled rejection instead of a fatal startup error. Both are now
  awaited.

### ⚠️ Downgrade warning

This release **migrates the vault database one way** (migration 010). It moves nine columns off
`Flashcards` — `level`, `sm2_reps`, `last_recall` and the six `fsrs_*` — into a new
`CardProgress` table, and drops them from `Flashcards`.

**An older build cannot open a vault this release has opened.** It names those columns directly
and will fail with `no such column: level` on the Trainer, the Stats view and the card browser.
The failure is loud and nothing is corrupted, but the only ways back are to restore the vault
folder from a backup taken before the upgrade, or to stay on this version.

Back up `{userData}/{vaultName}/` before upgrading if you may want to step back. Back up
`{userData}/accounts.db` regardless and on an ongoing basis: it holds every access token and
every non-owner's study schedule, and it is the one file in the app that cannot be rebuilt from
the canonical files on disk.
