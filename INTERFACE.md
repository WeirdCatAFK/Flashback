# Flashback Interface Design Specification

The Flashback UI is a React application rendered inside Electron. It communicates exclusively with the API process over HTTP — it has no direct access to the filesystem or database

---

## Layer Structure

The UI is organized in three strict layers. A layer may only import from layers below it.

```
Layer 3 — Views          src/ui/views/
Layer 2 — API modules    src/ui/api/
Layer 1 — Client         src/ui/api/client.js
```

- Views never call `fetch` directly. All HTTP calls go through `src/ui/api/`.
- API modules never hold React state. They return plain data.
- `client.js` is the only file that knows the API base URL.
- No component imports from another component's view folder.

---

## Layer 1  Client (`src/ui/api/client.js`)

The client is initialized once on startup with the base URL and API token received from Electron via IPC. After that it is a transparent request wrapper that attaches `Authorization: Bearer <token>` to every request.

Startup flow:

```
Electron main  →  ipcMain.handle('get-api-url' / 'get-api-token')  →  reads config.json  →  returns URL + token
React renderer →  window.flashback.getApiUrl()/getApiToken()       →  initClient(url, token)  →  app renders
```

The preload script (`src/electron/preload.cjs`) bridges IPC to the renderer using `contextBridge`. The renderer never imports from `electron` directly. The `.cjs` extension is required because Electron's sandboxed preload context is CommonJS-only — it does not support ES module `import` even when the project has `"type": "module"` in `package.json`.

Exports:

- `initClient(url, token?)` — called once in `index.jsx` before the React tree mounts; stores the base URL and bearer token.
- `request(method, path, body?)` — JSON request (token attached), throws on non-2xx.
- `upload(path, formData)` / `uploadWithProgress(...)` — multipart upload (token attached), throws on non-2xx.
- `appendToken(url)` — appends `?token=`/`&token=` to a URL for browser-initiated loads that can't send headers (`mediaFileSrc` in `api/media.js`, the PDF raw URL in `PdfRenderer.jsx`). No-op when no token is configured.

Errors thrown by `request` and `upload` carry a `.status` property so callers can branch on 400 vs 404 vs 500 without parsing message strings. A 401 means the token is missing or invalid.

---

## Layer 2 — API Modules (`src/ui/api/`)

One file per backend router domain. Each file exports plain async functions — no hooks, no state, no side effects.

```
api/client.js        Base fetch wrapper and URL store (Layer 1)
api/documents.js     /api/documents/*
api/media.js         /api/media/*
api/srs.js           /api/srs/*
api/subscriptions.js /api/subscriptions/*
api/seal.js          /api/seal/*
api/doctor.js        /api/doctor/*   (checkIndex / syncIndex / rebuildIndex — Vault Doctor)
api/reader.js        /api/reader/*   (an EPUB's images: list, <img> src, and as a File)
api/embed.js         the API's /embed/* pages (the YouTube player proxy)
api/desktop.js       window.flashback (Electron IPC) — config, window controls, updates, the MCP snippet
api/identity.js      /api/identity + the get-identity IPC;  api/vaults.js  /api/vault + the vault/remote IPCs
```

(Not every domain is listed here — `decks`, `highlights`, `categories`, `search`, `flashcards`, `progress`, `diary`, `accounts`, `tags` each have a sibling module too.)

`api/desktop.js` is the one exception to "one file per router": it wraps the preload bridge so
that no view touches `window.flashback` directly and a `dev:web` session without Electron gets
a clear error rather than an undefined call. `index.jsx` and `hooks/useConnection.js` still
call the bridge themselves — they are the bootstrap. URL builders (`rawDocumentUrl`,
`mediaFileUrl`, `youtubeEmbedUrl`) live beside the requests for their domain, so `client.js`
stays the only file that knows the base URL.

Function signatures mirror the route they call. Parameters match the backend's required fields exactly so there is no translation layer to maintain:

```js
// api/documents.js
export const listFolder = (path = '') =>
  request('GET', `/api/documents/list?path=${encodeURIComponent(path)}`);

export const createFile = (name, parentPath) =>
  request('POST', '/api/documents/file', { name, parentPath });
```

---

## Layer 3 — Views (`src/ui/views/`)

Views are the only layer allowed to own server state. Each view is a **folder** holding one
screen of the application and everything private to it:

```
views/trainer/
  Trainer.jsx            markup + handlers; the default export
  Trainer.css
  useTrainerSession.js   state, effects, API calls
  queue.js               pure reducers over the session queue (tested)
  grading.js             pure scheduling maths (tested)
  Reviewer.jsx           private subcomponents, one component per file or a few in one
  ScopeBar.jsx  SessionSummary.jsx  useDueCards.js  useTrainerScope.js  useReviewer.js  …
```

`App.jsx` lazy-loads `views/<name>/<Name>.jsx`; `views/graphMetrics.js` is the one file kept
at the top level, because `tests/graph.test.js` imports it by that path.

### Logic and rendering

Three kinds of file, told apart by what they export:

| file           | exports                              | may import                                  |
| -------------- | ------------------------------------ | ------------------------------------------- |
| `Name.jsx`     | components only                      | hooks, pure modules, `api/*`, other components |
| `useName.js`   | hooks only                           | `api/*`, pure modules, other hooks           |
| `name.js`      | plain functions and constants, no React | other pure modules, `translations/format.js` |

The `.jsx` is markup plus handlers: it calls one or two hooks, destructures, and renders.
State, effects and API calls live in the hook. Anything that can be computed without React —
ordering, geometry, parsing, validation, formatting — lives in a pure module with explicit
`.js` extensions on its imports, so `node --test` can load it with no bundler and no DOM
(`tests/ui.*.test.js`). A pure module that needs a translated string takes `t` as an argument
and is tested with the identity function. `react-refresh/only-export-components` is what
enforces the first row, and the gate runs lint with `--max-warnings 0` for that reason.

DOM-touching helpers that are not React (a TreeWalker over a clip body, a canvas painter) are
plain `.js` too, split so the arithmetic is a separate function from the DOM walk — see
`renderers/clip/ranges.js` versus `clipHighlights.js`, or `views/graph/paint.js`.

### State ownership

Server state (data fetched from the API) is fetched through the `api/*.js` modules and held in
`useState`/`useEffect` inside the view that needs it. Local UI state (which panel is open,
current selection) lives in `useState` or `useReducer` in the same place.

Do not lift server state into a parent component or React Context. Each view fetches its own data. This scopes re-renders and makes views independently loadable. When a write succeeds, refresh exactly the data it invalidated: `utils/dataBus`'s `invalidateData()` / `useDataInvalidation()` is the one broadcast, and every view that subscribes refetches.

#### The one exception: session identity

`src/ui/session.jsx` provides `SessionProvider`, and `src/ui/sessionContext.js` the
`useSession()` / `useCan()` hooks that read it. It holds who you are on the connected vault
and what that lets you do — nothing else.

The rule above is about *vault data*: documents, cards, decks, statistics. Lifting those into a
provider is how a React app ends up with one god-object and no idea what refetches when, and
that stands. The caller's account is a different kind of value — it is session identity, the
sibling of `connection` in `hooks/useConnection.js`: one object, fetched once from
`GET /api/identity`, changing only when the app is pointed somewhere else. And it is needed at
the *leaves* — the delete item inside a file-tree context menu, the edit button on a card — so
the alternative is drilling a prop through Documents → tree → node → menu in most views.

The boundary is the whole point: identity and permission, nothing else. Anything describing
the vault's contents still belongs to the view that shows it.

Two properties worth knowing:

- On a local vault the account resolves to the Author, every capability answers true, and the
  desktop UI is unchanged. That is what made this safe to add everywhere at once.
- It fails closed, but not silently. If the identity call fails there is no optimistic
  fallback to the Author: `role` stays null, every capability answers false, and `error` is set
  so the title bar can say "Role unknown" rather than leaving someone in front of an app that
  has quietly lost half its buttons. A 401 is an answer and is not retried; anything else is
  retried five times at one-second intervals, because this provider sits *outside* `AppGate`
  and a local vault switch restarts the database underneath it.

#### Hiding versus disabling a control

Capabilities come from `src/shared/roles.js` (`CAPABILITIES`, `can(role, capability)`), which
`tests/capabilities.test.js` pins against the API's real permission table — so a control cannot
drift from the guard that would refuse it. Two rules, because either one alone gets it wrong in
a different direction:

- Hide a control that is categorically not this person's: New document, Delete, Import,
  Rollback, Rebuild, the authoring tabs. A Reader's app should read as a *reading* app, not an
  authoring one with half its buttons broken.
- Disable, with the reason in the `title`, where the control sits beside something they
  *can* do and its absence would be mysterious — the Edit button at the foot of a card's
  statistics panel, say. Use `capabilityHint(t, capability)` from `src/ui/roleLabels.js`, which
  names the role required.

Navigation is never hidden by role. A Reader keeps Documents, Trainer, Stats and Logs; what
changes is what they can *do* there. The one exception is the Server tab, which is absent on
a local vault because there is nothing behind it — see `remoteOnly` in `App.jsx`'s `NAV_ITEMS`.

One nav item is renamed by the connection rather than by the role: the study record is
"Diary" on a local vault and "Logs" on a remote server, because on a server one git
history holds several people's prose and an admin can read it — a private-journal name would
promise privacy the deployment cannot deliver, and locally it is simply true. Both label sets
live in `src/ui/diaryLabels.js` (`diaryLabels(t, shared)`, `isSharedVault(connection)`); only
the label moves, never `/api/diary`, `diary/` or `fb-diary-enabled`. `connection` reaches
`DiaryView` and `ConfigView` as a prop from `App.jsx`, which owns the one `useConnection()`
subscription — do not call that hook in a leaf view.

Where a control is an editor rather than a button, prefer read-only over hidden: the
Inspector's tag list, a deck's tags and the Manage tab's categories all still render their
values without the role, because the values are information even to someone who cannot change
them. A body editor is the opposite case and is set genuinely `readOnly` — a writable editor
whose save is refused invites someone to type a page and lose it.

---

## Size tokens

Every spacing, radius, type size, control height, box size, z-index, duration and easing in a
stylesheet under `src/ui/` is a token from `src/ui/index.css`'s `:root` block. Per-file CSS
declares no px, ms, `cubic-bezier()`, hex or `rgb()` of its own; `npm run check:tokens`
(`scripts/check-tokens.js`) fails on any that appears, and `check:ui` runs it.

| family    | tokens                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------- |
| spacing   | `--space-0-5` 2 · `-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 · `-12` 48 · `-16` 64 |
| radius    | `--radius-sm` 4 · `-md` 6 · `-lg` 10 · `-pill`                                                          |
| type      | `--text-xs` 11 · `-sm` 12 · `-base` 14 · `-md` 16 · `-lg` 20 · `-xl` 28 · `-2xl` 40                     |
| controls  | `--control-xs` 20 · `-sm` 24 · `-md` 28 · `-lg` 32 · `-xl` 36 · `-2xl` 40 · `-bar` 48 — heights of buttons, inputs, rows |
| icons     | `--icon-sm` 14 · `-md` 16 · `-lg` 20 · `-xl` 24                                                          |
| sizes     | `--size-xs` 80 … `--size-9xl` 1240 — the large-box ladder: panels, popovers, dialogs, prose measures    |
| z-index   | `--z-raised` 1 · `-sticky` 10 · `-floating` 100 · `-modal` 1000 · `-popover` 1100                       |
| motion    | `--dur-fast` 120 · `-base` 200 · `-slow` 300; `--ease-out`, `--ease-in-out`                              |
| focus     | `--shadow-focus` — the one ring every focusable control shares                                          |

**Snapping.** When a value is not on a ladder, take the nearest step; a tie rounds **down**,
so the UI keeps the density it has rather than drifting looser (13px text became `--text-sm`,
6px gaps `--space-1`, 14px padding `--space-3`). Do not add a step to fit a value; find the
step the value should have been.

**Allowed literals.** `0`; `1px`/`2px` on `border*`, `outline*` and as a hairline
`width`/`height`; offsets inside `transform`/`translate`, `text-shadow`, `background-*`,
`letter-spacing`; `@media` parameters (CSS forbids `var()` there); `animation` durations
of 400ms and up (a keyframe's tempo is its own thing). Anything else is a finding.

**Stacking.** Anything transient that dismisses on outside click — a Popover, the context
menu, the selection toolbar — sits at `--z-popover`, *above* `--z-modal`, because a popover
can open from inside a dialog and never coexists with a dialog opened after it. Renderer
overlays (a clip's save button, the PDF rubber band) are `--z-floating`; sticky toolbars
`--z-sticky`.

**Colours** stay per-theme and are covered under Theme tokens; two platform constants
(`--color-window-close`, `--color-media-bg`, `--color-white`) sit on `:root` because they
are the same in every theme by design.

---

## App Shell (`src/ui/App.jsx`)

`App.jsx` owns the top-level navigation state (which view is active) and the handful of things that cross views — theme and zoom, the study hand-over to the Trainer, whose progress Stats and Graph show, and the dialogs opened from the title bar. Views are lazy-loaded with `React.lazy` and wrapped in `Suspense` so they are only bundled and fetched when first visited.

```js
const DocumentsView  = lazy(() => import('./views/documents/Documents'));
const FlashcardsView = lazy(() => import('./views/flashcards/Flashcards'));
const GraphView      = lazy(() => import('./views/graph/GraphView'));
```

`App.jsx` does not fetch data, does not hold server state, and does not know what the active view renders. It only switches between views.

### App zoom and the two coordinate spaces

`App.jsx` also owns app zoom (Ctrl `+`/`−`/`0`, persisted as `fb-zoom`): it writes `--ui-zoom` on `<html>`, and `App.css` applies it as `#app-shell { zoom: var(--ui-zoom, 1) }`. That one declaration splits the renderer into two coordinate spaces, and mixing them is the single easiest geometry bug to write:

| space                                | what reports it                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| viewport (zoom-multiplied) | `getBoundingClientRect()`, a `MouseEvent`'s `clientX`/`clientY`, `window.innerWidth`/`innerHeight`, and anything rendered outside `#app-shell` (portaled to `document.body`)                                                          |
| layout (unzoomed CSS px)   | `offsetWidth`/`clientWidth`, inline `style.left/top/width`, and everything rendered inside `#app-shell` — `position: fixed` included, because `zoom` scales a fixed element's own offsets without making it a containing block |

The rule: position every floating overlay in layout space. An overlay inside `#app-shell` needs nothing extra. One portaled to `document.body` carries `zoom: var(--ui-zoom, 1)` in its own CSS so it scales with the document it annotates (`SelectionToolbar.css`). Geometry arriving in viewport space is converted at the point of capture, never at render — that way every placement constant downstream stays plain layout px and no call site has to know any of this.

`src/ui/utils/uiZoom.js` is the only module that reads `--ui-zoom`: `getUiZoom()`, `toLayoutRect()`, `layoutViewport()`, plus `useUiZoomChange()` for overlays that must dismiss when the anchor moves (a zoom change is as invalidating as a scroll). `GraphView.css` is the one deliberate exception — it counter-zooms with `zoom: calc(1 / var(--ui-zoom, 1))` because its D3 transform math is in root pixels.

Anything that persists captured geometry has to strip the zoom too, not just overlays: `PdfRenderer`'s highlight `bbox` is stored in PDF units, so its capture divides by `scale * getUiZoom()` — dividing by `scale` alone banks the zoom into the sidecar and the box reopens in the wrong place.

---

## Entry Point (`src/ui/index.jsx`)

`index.jsx` is the only place where startup sequencing happens. It calls `getApiUrl()` and `getApiToken()` over IPC, initializes the client, then mounts the React tree. Nothing renders until the URL is known.

```js
const url = await window.flashback.getApiUrl();
const token = await window.flashback.getApiToken();
initClient(url, token);
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TranslationProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </TranslationProvider>
  </StrictMode>
);
```

---

## Optimization Rules

These rules follow directly from the re-render model described by React. They are ordered by impact.

### 1. Push state down

If a piece of state only affects one subtree, it belongs in that subtree — not in a parent. State that lives too high causes siblings to re-render unnecessarily.

```
❌  DocumentsView owns searchQuery → FileTree re-renders on every keystroke
✓   SearchBar owns searchQuery     → FileTree is unaffected
```

### 2. Memoize at the boundary, not everywhere

Wrap a component in `React.memo` only when:

- it is demonstrably slow to render, and
- its props can be made stable (objects and functions must be memoized with `useMemo`/`useCallback` before being passed in).

`useMemo` and `useCallback` on their own have a cost. They are only valuable when they prevent a downstream re-render.

### 3. Long lists

Rendering 500 DOM nodes at once is slow regardless of React optimizations, and the lists that
can get there are the file tree, review history, search results and the graph node list. There
is no virtualization dependency; what exists is paging at the API: the card browser reads `GET /api/decks/cards` with `limit`/`offset`, and `GET
/api/search` caps at 100 results (20 by default). The file tree renders one folder at a time and
is not bounded — a folder with thousands of documents in it is the case this section is still
about. Keep new lists paged for the same reason, and do not add a virtualization dependency to
satisfy this section without deciding to adopt one deliberately.

### 4. Code-split at the view boundary

Views are already lazy-loaded in `App.jsx`. Do not lazy-load individual components within a view — the overhead is not worth it at that granularity.

### 5. Derive

If a value can be computed from existing state or query data, compute it during render. Do not sync derived values into `useState` — it creates two sources of truth and introduces update timing bugs.

---

## Component Conventions

### `src/ui/components/`

Shared components are named after the things a person sees — a card, a deck, a document, a
highlight, a vault, an account — so `<CardRow>` or `<DeckPurgeDialog>` is understood without
opening it. What has no domain name lives one layer down, in `base/`.

```
components/
  base/        what has no domain name: Modal, Popover, Toggle, ProgressBar, StatTile,
               ConfirmDialog, ContextMenu, StateView (Loading/Error/Empty), TagChipInput,
               ProgressDialog, ConflictBanner, SegmentedControl, Stepper, InlineConfirm,
               QuietRow, ShownOnce — and base.css, the class vocabulary below
  account/     RoleBadge, IdentitySection, ProgressScopePicker
  vault/       VaultManager, VaultSwitcher
  shell/       AppGate, TitleBar, SearchModal, ShortcutsOverlay, KeybindingsEditor, OnboardingTour
  flashcard/   Flashcard, CardRow, CardDetailModal, FlashcardForm, FlashcardEditor,
               StandaloneCardModal, BookImagePicker, ClipMediaPicker, ReviewStrip, RetentionCurve,
               flashcardFields.js
  deck/        DeckPurgeDialog, AnkiMappingModal
  highlight/   SelectionToolbar, HighlightRemoveDialog
  document/    DocumentEditor (+ useDocumentEditor, useSelectionToolbar, useHighlightActions,
               tabsState.js), EditorTabBar, ReadingBar, useReadProgress
    explorer/  FileExplorer, FolderNode, FileNode, TreeParts, ExplorerDialogs,
               names.js, dragDrop.js, contextMenu.js, useExplorerTree, useFolderChildren,
               useRename, useDropTarget
    inspector/ Inspector and its four tabs
    renderers/ registry.js, highlights.js, highlightId.js, scroller.js,
               useHighlightableRenderer, useScrollProgress, Renderer.css, SourceUrlForm
      markdown/ text/ pdf/ epub/ youtube/ clip/   one folder per format
  icons/       SVG glyphs + fileIconMap.js
```

**Placement rule.** A component used by one view lives in that view's folder. One that names
a thing the person sees in more than one place lives in `components/<thing>/`. One with no
domain name lives in `components/base/`. `hooks/` holds hooks with no domain either
(`useImports`, `usePersisted`, `useContainerSize`, `useThemeVersion`, `useConnection`,
`useKeybindings`).

**`base.css` is the presentation vocabulary**, imported once from `index.jsx`. A pattern is a
CSS class when it carries no state, a11y or geometry, and a React component when it does:

| class                                                             | for                                              |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `.btn` `--primary` `--danger` `--danger-quiet` `--ghost` `--accent-quiet` `--quiet` `--quiet-accent` `--sm` `--lg` `--icon` `--block`; `.btn-close` | every button that is not a grade button or an activity-bar tab |
| `.link-action` `--danger`                                         | a row's secondary action: text, no box            |
| `.badge` `--accent` `--danger` `--outline`                        | an uppercase micro-label                          |
| `.chip` `--muted` `--danger` + `.chip__remove`                    | a removable token                                 |
| `.eyebrow` (mono, uppercase), `.header-row`, `.section-header`, `.panel`, `.toolbar`, `.divider-v` | section chrome                          |
| `.field` `--sm`                                                   | the one input override (uses `--color-border-strong`) |
| `.spinner`, `.progress`, `.stat-tile`, `.toggle`, `.popover`, `.segmented`, `.stepper`, `.inline-confirm`, `.quiet-row`, `.shown-once` | the interiors of the base components              |
| `.muted`                                                          | secondary text                                    |

A per-view stylesheet keeps only layout and what is genuinely particular to that view. When a
view needs a button that looks different from `.btn`, it adds a modifier class beside `btn`,
not a parallel button.

**Quiet controls, bold indicators.** `.btn--quiet` and `.btn--quiet-accent` are the flat,
outlined buttons that sit beside content; the filled `.btn--primary` is for the one action a
dialog or a page is for. Weight belongs to what reports state (counts, badges, progress, the
Trainer's pops), not to controls. The design language is described in § Design language.

- **SegmentedControl** — a few mutually exclusive choices people compare rather than look
  up (a scheduler). Buttons with `aria-pressed`.
- **Stepper** — a number nudged with − and +. The value has a fixed width so nothing beside
  it shifts; what a step does (jump to "All", say) is the caller's.
- **InlineConfirm** — a confirmation in place, beside what it is about, instead of a modal.
  It states the consequence in plain words; Cancel takes focus so a stray Enter is never the
  destructive choice. `tone="neutral"` for a choice that loses nothing.
- **QuietRow** — a list row whose secondary actions appear on hover or focus (always, on a
  device without hover). `onOpen` makes the row itself open the item.
- **ShownOnce** — a secret that exists only in the response that created it (an access
  token): obtrusive, and it says that dismissing it loses the value.

**Popover** (`base/Popover.jsx`) is the one anchored overlay: it portals to `document.body`,
positions from the anchor's rect converted to shell-layout space (`utils/uiZoom.js`), flips at
the viewport edge, and dismisses on outside mousedown, Escape, scroll, resize and a zoom
change. Menus, pickers and suggestion lists render their items inside it with
`.popover__item` / `__heading` / `__sep`; none of them own position math.

**Modal** (`base/Modal.jsx`) is every dialog: portal, `role="dialog"`, focus trap, Escape,
backdrop click, `size`, `placement="top"` for the search palette, `dismissible={false}` for
progress. The dialog's stylesheet styles its interior only; the chrome is Modal's.

### File naming

| What                | Convention                                        |
| ------------------- | ------------------------------------------------- |
| Views               | `views/<name>/<Name>.jsx` + `<Name>.css`          |
| Components          | `PascalCase.jsx` + `PascalCase.css` beside it     |
| Hooks               | `useName.js`                                      |
| Pure modules        | `camelCase.js`, imports with explicit `.js`       |
| API modules         | `api/camelCase.js`                                |

### Comments

The convention is the backend's, enforced by `eslint.config.js` on `src/ui/**` too: a
`/** … */` header at the top of every file saying what the module is; one sentence of JSDoc per
function, with `@param`/`@returns` only where the signature does not already say it; no
comments inside function bodies, no section banners, no trailing comments. Rationale lives
here, in the section for the area it belongs to.

---

## Renderers & the Highlight Contract

`components/document/renderers/` holds one editor per file type plus the shared
highlight machinery. `DocumentEditor` chooses a renderer through
`renderers/registry.js` and talks to it through a fixed prop contract — it never imports
TipTap or touches an editor instance directly. Current routing: `md`/`markdown`
→ `MarkdownRenderer`, `txt`/`text` → `TextRenderer`, `pdf` → `PdfRenderer`,
`epub` → `EpubRenderer`, `youtube` → `YoutubeRenderer`, `clip` → `ClipRenderer`, else
`PlaceholderRenderer`.

The registry is one table doing two jobs, and they cannot be separated. Each entry pairs
a `lazy()` import of the component with its `editable`, `supportsHighlight`,
`tracksProgress` and `ownsReadingBar` flags. The
components are lazy because pdf.js, epub.js and TipTap are about a megabyte between them and
statically importing all of them meant opening *any* document paid for *every* format — the
`Documents` chunk was 1.4 MB and is now 60 kB, with each heavy renderer fetched on first use.
The flags cannot be lazy: `editable` decides whether the tab bar draws a Save button and
`supportsHighlight` decides whether `SelectionToolbar` offers to highlight, `tracksProgress`
decides whether a reading bar is built at all, `ownsReadingBar` decides whether it is drawn
above the document or handed to the renderer, and all four are needed outside the
`<Suspense>` boundary. So they are declared as plain data in the registry rather
than as statics on the component (`MyRenderer.supportsHighlight = true`), which a lazy
component cannot expose until its chunk has arrived. Adding a format is one entry.

`PdfRenderer`, `ClipRenderer`, and `YoutubeRenderer` are the non-editable
references: they own their own load/save (metadata-only — the body is immutable)
instead of `useHighlightableRenderer`, and supply their own `highlightRef` object.
`ClipRenderer` anchors highlights by character offset into the container's
`textContent` (`clip_range`); `YoutubeRenderer` anchors by timestamp
(`video_timestamp`) created via a "Mark this moment" button rather than a text
selection.

### The renderer prop contract

Every renderer receives the same props from `DocumentEditor`:

| Prop                    | Direction | Purpose                                                                                                                                  |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                | in        | Active file path; changing it loads a new document.                                                                                      |
| `draftContent`        | in        | Unsaved body to restore, or`undefined` to load from disk.                                                                              |
| `saveRef`             | out (ref) | Set to`(metaTransform?) => Promise` so the parent can trigger a save.                                                                  |
| `highlightRef`        | out (ref) | Set to the highlight command object (see below), or`null` if unsupported.                                                              |
| `onDirtyChange`       | callback  | `(path, isDirty)` — drives the tab's dirty dot.                                                                                       |
| `onDraftChange`       | callback  | `(path, body \| undefined)` — body on edit, `undefined` once saved.                                                                  |
| `onHighlightsChange`  | callback  | `(path, highlights[])` — registry after load and after each save.                                                                     |
| `onSidecarRefresh`    | callback  | `(path, metadata)` — full sidecar after load/save (cards, tags, …).                                                                  |
| `onExternalSelection` | callback  | `({ text, rect }) \| null` — for renderers whose selection lives outside the top window (EPUB's iframes); drives `SelectionToolbar`. |
| `onImagePick`         | callback  | `({ href, name, alt })` — the reader offering a picture as a card's front. Optional; only `EpubRenderer` fires it.                  |
| `initialProgress`     | in        | The saved reading position to resume at; `null` when never opened and `undefined` while still loading. Renderers must wait for it to become defined rather than assuming an order — the body and the position race. |
| `onProgress`          | callback  | `(path, { unit, position, percent, total })` — report freely, on every scroll or relocation. Debounce and the dwell guard live in `useReadProgress`, not at the call site. |
| `progressRef`         | out (ref) | Set to `{ goToStart(), currentPosition() }`, or leave null. Drives the reading bar's "Go to start" and "Set mark here". |
| `readingBar`          | in        | A ready-built `<ReadingBar>` element, passed only to renderers whose registry entry sets `ownsReadingBar`. Render it inside your own toolbar; `undefined` otherwise. |
| `readOnly`            | in        | The caller may not write this document's body. Editor-backed renderers pass it to`useHighlightableRenderer`, which makes the editor non-editable. |

### Reading position

A renderer that sets `tracksProgress` owes three things: it resumes at `initialProgress`, it
reports where the reader gets to through `onProgress`, and it publishes `goToStart` /
`currentPosition` on `progressRef`. `DocumentEditor` owns none of the policy — the dwell
guard, the write debounce and the auto-versus-manual rule all live in `useReadProgress`, so a
renderer reports as often as it likes and never decides when to write.

Where the bar goes is the editor's decision, not the renderer's. A format with no chrome
of its own (Markdown, text, clips) gets the standalone `.doc-reading-bar` strip above the
document. A format that already draws a toolbar — PDF, EPUB, YouTube — sets `ownsReadingBar`
and receives the same element through the `readingBar` prop to place inside that toolbar. Two
full-width bars with the same surface and the same bottom border, one directly under the
other, is what the flag exists to prevent; on a PDF it stacked three strips deep under the tab
bar. `ReadingBar` is still imported statically by `DocumentEditor` and built there, so it
never enters a lazy chunk — only its mount point moves — and its `inline` variant drops the
surface and shortens the position text (`p. 12`, not `Page 12 of 40`) so it reads as one item
in a toolbar rather than a transplanted row.

The scroll container is rarely the renderer's own element. `findScroller`
(`renderers/scroller.js`) walks up from any element until it finds one that both overflows
and has something to scroll. Markdown, text and clips need it because TipTap, CodeMirror and a
plain div each put the scrollbar somewhere different; PDF needs it because *nothing it owns
scrolls at all* — `.doc-editor-renderer` does. Attaching a `scroll` listener to a descendant
of the real scroller silently never fires, and measuring page positions against a container
that itself scrolls reads page 1 forever, which is exactly how PDF progress was broken.

Resume waits for a pair, not an order. `initialProgress` arrives from the network and the
body arrives from disk or a parser; either can win. Every renderer guards with a `resumedRef`
and an effect depending on both, rather than assuming the position is there when the body
loads.

Positions are expressed in the reader's units (`page`, `section`, `chars`, `segment`), not
in whatever the renderer finds convenient, because the same locator has to address
`/api/reader` for MCP reads. Two consequences worth knowing before adding a format:

- EPUB stores a CFI *and* an `href`. `mcpReader` numbers only sections that have text, so
  its ordinals are not epub.js's spine indices. The CFI resumes the renderer, the href
  addresses the reader, and neither is converted into the other.
- Text formats are a scroll fraction. No text renderer keeps a character offset —
  Markdown keeps no offset state at all — so `useScrollProgress` measures the scrollbar and
  derives the offset from the percentage. It is a sound bound for "do not read past here", not
  a cursor, and `body_etag` marks it stale once the body is edited underneath it.

`readOnly` is set by `DocumentEditor` from the `editDocumentBody` capability, and it applies to
exactly the renderers with `editable = true` (Markdown and text). Those two are the formats
whose highlights live in the body as marks in the prose, so annotating one is the same
`PUT /api/documents/file` as editing it — admin. Every other renderer persists highlights
through `PUT /metadata` (collaborator) and is unaffected, which is why a Collaborator can
annotate a PDF but not a note. That is a fact about where the data lives, not a gap in the
permission table.

A renderer that supports highlighting says so in the registry, not on itself, so the parent
can enable the highlight toolbar without knowing the renderer's identity — and without having
loaded it yet:

```js
// renderers/registry.js
pdf: {
    load: lazy(() => import('./PdfRenderer')),
    extensions: ['pdf'],
    editable: false,
    supportsHighlight: true,
},
```

### Building a highlightable renderer

Editor-backed renderers do not re-implement the load/save/dirty/draft
lifecycle. They call `useHighlightableRenderer`, which owns all of it (including
the empty-state save guard and Ctrl+S) and delegates only what differs:

```js
const { editor, loading, conflict, reloadFromDisk, overwrite } = useHighlightableRenderer({
  ...props,
  extensions,                 // the editor's extension list
  editorClass,                // class on the ProseMirror node
  serialize:   (editor) => …,        // editor → body string written to disk
  loadContent: (editor, body, meta) => …, // body (+ anchored highlights) → editor
  reconcile:   (editor, existing) => ({ highlights }), // live editor → registry
});
```

### When a save is refused

The hook captures the document's `etag` when it loads content and sends it back as `ifMatch` on
every save (see API.md § Concurrent writes). If the document changed underneath, the write is
refused and the hook sets `conflict` — the draft stays in the editor, because it is the
user's typing and losing it is the exact failure this guards against.

A renderer with an editable body renders the shared banner and hands it the two ways out:

```jsx
{conflict && <ConflictBanner onReload={reloadFromDisk} onOverwrite={overwrite} />}
```

`reloadFromDisk` discards the draft and takes what is on disk now; `overwrite` re-sends without
a version, so this draft wins. There is no automatic resolution and there should not be — only
the person who typed it knows which version matters. A banner rather than a modal, so the draft
being decided about stays visible behind it.

The caller renders its own `<EditorContent>` wrapper, so markup and CSS stay
per-renderer. `MarkdownRenderer` and `TextRenderer` are the reference
implementations: markdown anchors highlights inline (`<mark data-hl>`, no
load-time apply step); plain text anchors them by character offset in the
sidecar and re-applies on load.

### The highlight command contract

`highlightRef` is the only highlight surface `DocumentEditor` depends on — a
plain object, not a TipTap reference. `createHighlightCommands(editor)` in
`highlights.js` is the TipTap implementation; a non-TipTap renderer (PDF,
CodeMirror, …) can supply its own object of the same shape:

| Method             | Returns                                            | Used by              |
| ------------------ | -------------------------------------------------- | -------------------- |
| `toggle(color)`  | `{ kind: 'created'\|'recolored'\|'removed', id }`  | color dots           |
| `unset()`        | `{ kind: 'removed', id }` \| `null`            | the ✕ button        |
| `ensure(color?)` | `{ kind: 'existing'\|'created', id }` \| `null` | Card / Ref buttons   |
| `currentId()`    | the highlight id under the selection, or`null`   | orphan-removal check |
| `scrollTo(id)`   | scrolls the view to that highlight                 | Highlights tab jump  |

The sidecar `highlights[]` registry shape is documented in `DATAMODEL.md`; it is
uniform across anchoring strategies (offset fields are simply absent for inline
anchoring), so the Inspector, cards (`location: { type: 'highlight', id }`), and
Highlights tab work with any renderer unchanged.

---

## IPC Surface

The preload script exposes exactly one namespace: `window.flashback`. New IPC channels must be added to both `preload.cjs` (as a `contextBridge` method) and `main.js` (as an `ipcMain.handle` handler). The renderer never imports from `electron` directly.

Current channels:

Vault, identity and connection channels are the exception to "the renderer talks to the API over HTTP": the vault registry, the user identity and remote credentials belong to the machine rather than to any one vault, so they live in the main process. The identity channels are a deliberate split — main writes it (it owns the `user` key in `config.json`), while what would actually be *stamped* is resolved by the API and read from `GET /api/identity`, so the override → global → default precedence exists in one place instead of two that drift. `get-active-connection` returns a `{url, token}` pair for *either* the local API or a remote Flashback Server — that sameness is why switching vaults and connecting to a remote are one mechanism in the UI (`useConnection` → `initClient` → a `connectionId` remount key), not two.

| Channel                   | Direction        | Purpose                                                                                                                                                                                                 |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-api-url`           | renderer → main | Get the API base URL derived from config.json                                                                                                                                                           |
| `get-api-token`         | renderer → main | Get the API bearer token from config.json (for`initClient`)                                                                                                                                           |
| `get-config`            | renderer → main | Read the full config.json object                                                                                                                                                                        |
| `set-config`            | renderer → main | Write a new config.json object; returns`{ ok, error? }`                                                                                                                                               |
| `is-first-run`          | renderer → main | True when config.json is absent or`--onboarding` was passed                                                                                                                                           |
| `complete-setup`        | renderer → main | Write initial config, mint token, spawn API; returns`{ ok, error? }`                                                                                                                                  |
| `restart-app`           | renderer → main | Relaunch the app                                                                                                                                                                                        |
| `get-user-data-path`    | renderer → main | Electron userData path (onboarding path preview)                                                                                                                                                        |
| `get-mcp-config`        | renderer → main | Ready-to-paste MCP server config snippet                                                                                                                                                                |
| `get-app-version`       | renderer → main | Running app version (Config → About)                                                                                                                                                                   |
| `updater-check`         | renderer → main | Check GitHub for a newer version;`{ ok, version?, dev?, error? }`                                                                                                                                     |
| `updater-download`      | renderer → main | Download the available update;`{ ok, error? }`                                                                                                                                                        |
| `updater-install`       | renderer → main | Quit and install the downloaded update                                                                                                                                                                  |
| `update-status`         | main → renderer | Update lifecycle events (`checking`/`available`/`downloading`/`downloaded`/`none`/`error`); subscribe via `onUpdateStatus`                                                                |
| `renderer-error`        | renderer → main | Forward an uncaught renderer error into the main log file                                                                                                                                               |
| `flashback-navigate`    | main → renderer | `flashback://` link that reached `will-navigate` (safety net)                                                                                                                                       |
| `window-minimize`       | renderer → main | Minimize the window                                                                                                                                                                                     |
| `window-maximize`       | renderer → main | Maximize or unmaximize the window                                                                                                                                                                       |
| `window-close`          | renderer → main | Close the window (hides to tray unless quitting)                                                                                                                                                        |
| `list-vaults`           | renderer → main | Registered local vaults +`activeVaultId`, each with resolved `path`/`active`/`missing`                                                                                                          |
| `create-vault`          | renderer → main | Create and register an empty vault;`{ ok, vault?, error? }`                                                                                                                                           |
| `rename-vault`          | renderer → main | Release the DB, move folderand `{name}.db`, switch back, repair the index                                                                                                                   |
| `remove-vault`          | renderer → main | Unregister a vault. Never deletes files                                                                                                                                                                 |
| `switch-vault`          | renderer → main | Ask the API to open another local vault in-process, and point the app at the local API — it is a local-vault action, so it also leaves any remote                                                    |
| `open-vault-from-disk`  | renderer → main | Directory picker; adopts an existing vault where it stands                                                                                                                                              |
| `get-identity`          | renderer → main | What isstored: `{ user, override, suggested, activeVaultId }`. What is *stamped* comes from `GET /api/identity`; `suggested` is available before the API exists, for the setup wizard |
| `set-identity`          | renderer → main | Set the global`{name, email}`; both halves required. `{ ok, error?, field?, code? }`                                                                                                                |
| `set-vault-identity`    | renderer → main | Set or (with`null`) clear this vault's identity override                                                                                                                                              |
| `list-remotes`          | renderer → main | Registered Flashback Servers (`{id, label, url, hasToken}`) — never a token                                                                                                                          |
| `add-remote`            | renderer → main | Register a remote; its token is encrypted via`safeStorage`                                                                                                                                            |
| `remove-remote`         | renderer → main | Unregister a remote                                                                                                                                                                                     |
| `test-remote`           | renderer → main | Handshake`GET <url>/api/vault`; `{ ok, identity?, error? }`                                                                                                                                         |
| `get-active-connection` | renderer → main | `{ kind: 'local'\|'remote', id, label, url, token }` — what `initClient` needs                                                                                                                      |
| `use-local-vault`       | renderer → main | Point the app back at the local API                                                                                                                                                                     |
| `use-remote`            | renderer → main | Handshake, then point the app at a remote                                                                                                                                                               |
| `connection-changed`    | main → renderer | The active connection moved; subscribe via`onConnectionChange`                                                                                                                                        |

Which of the two places the app is pointed at lives in `src/electron/connection.js`, not in
`main.js` — one flag, and `useLocalVault()` is the only thing that clears it by intent, so
every route home goes through the same call. `connectionForRemote` reads the registry and
never the network, so an unreachable remote resolves forever: nothing times out and drops
you back to a local vault, which is why the deliberate route has to work. It is pinned by
`tests/connection.test.js`, which runs under plain Node because the module takes its
dependencies as arguments and imports no Electron.

---

## What Does Not Belong in the UI Layer

- Filesystem access of any kind (all file operations go through the API).
- SQLite queries or direct database references.
- Business logic (SRS scheduling, sidecar merging, tag propagation). The API owns all of this.
- Hardcoded port numbers or API paths outside of `api/client.js` and `api/*.js`.

---

## Rationale by area

What the comment pass took out of the source, kept here by area. Each entry is a decision that
is not derivable from the code and that a future change is likely to reverse by accident.

### App shell (`App.jsx`, `components/shell/`, `components/vault/`)

- **`AppGate` is keyed on the connection.** Views stay mounted after their first visit (the
  view-slot keep-alive), so switching vault or connecting to a remote must unmount everything
  inside the gate or the previous vault's documents, cards and graph stay on screen. Remounting
  the gate also resets its latched `ready`, so a local switch waits for the API to finish
  re-opening instead of firing reads at a closing database. `SessionProvider` wraps the *whole*
  shell, title bar included, and is keyed the same way so pointing elsewhere re-asks who you are.
- **`VaultManager` mounts outside the gate.** It is the thing that ordered the switch, so it
  has to outlive the remount long enough to report a failure rather than vanish with the vault
  it was leaving. `VaultSwitcher` lives in the title bar for the same reason and therefore
  survives a switch: it closes itself by hand and re-reads the registry with `connection` in
  its deps, or every row keeps the `active` flag the server sent *before* the switch.
- **Going to the vault the local API already has open is a re-point, never a switch** — no
  database work, nothing that can fail. That is the way home from a misconfigured or
  unreachable remote. Only a *different* vault needs `switchVault`.
- **App-level state that holds a vault path resets on a connection change** (`fb-open-folders`,
  the trainer scope hand-over, `progressAccount`), and a remote-only view is left behind when
  the app goes local, or its nav button disappears while its panel stays up with nothing in it.
- **The onboarding tour is gated by localStorage only**, never `config.json`, so replaying it
  from Config can never re-trigger the setup wizard. It mounts inside the gate because it points
  at the real nav. Views are lazy, so after switching view it retries across a few frames until
  the target element exists.
- **Title bar:** the product name leads (it is what the window is), the active vault sits
  beside it (it is the part that changes), then the role badge (renders nothing locally). The
  current-vault marker is a dot, not a tick — a tick reads as "done", and the question the menu
  answers is "which one am I in".
- **Search:** the `tag:`/`deck:`/`doc:`/`in:` prefixes are literal query syntax and must
  survive translation. Filter mode renders a flat list; global mode groups by type.

### Trainer (`views/trainer/`)

- **Never re-sort the queue.** The server sequenced it — by pedagogical tier, then by graph
  distance within each tier. The previous client sort was a stable sort on category priority
  alone, so every tie resolved to creation order and a session always played back in the order
  the cards were authored. `isNew` is not a column; it is which bucket the server put the card in.
- **A failed card is re-queued within its tier, at least `REQUEUE_LAG` cards later**
  (`queue.js insertIndexFor`). Two constraints in this order: never past the tier boundary (a
  failed Definition must not fall behind the Exercises built on it); never immediately (re-showing
  a card you just failed tests recognition, not recall). The lag mirrors the sequencer's own
  `MIN_LAG`. Clamping to the tier end, never to index 0: one card past the boundary is a smaller
  price than no lag at all.
- **Grading** (`grading.js`): FSRS sends a rating and the server computes the schedule;
  Leitner/SM-2 are computed here and posted back. Leitner "Again" floors at level 1 — level 0
  would make the card permanently due every session; SM-2 level 0 already gives one day. The
  ease clamp is 1.3–3.0. A `type_answer` card grades only `answerText` — its `backText` is
  post-review notes the reviewer was never asked to reproduce (on a pre-split card `backText` is
  the answer, resolved by `flashcardFields.js`). An empty notes field is not a missing back.
- **The UI advances optimistically, and a failed write is never silent** — it is a dismissible
  banner, so an optimistic advance cannot hide lost progress.
- **Undo** restores the snapshot taken before the last grade, reverses the review on the
  server, and rewinds the presentation trace too: the undone log row is deleted server-side, so
  leaving the position advanced would put a gap in the session's ordering record. The trace
  counts what was actually shown (a re-queued card advances the position again), and
  `prevCardHash` is the card seen immediately before, not the one the sequencer planned. The
  undo shortcut lives on the parent so it works from the summary after the reviewer unmounts.
- **Card-health flags are reported at the end of the session, never mid-card.** Interrupting a
  review to say the card is badly built is the wrong moment; only failures reach the list, keyed
  by hash so a card that fails twice is named once.
- **Scope.** Exclusions are a set, not a slot — several bulk imports is the case they exist
  for. An "exclude this" launch from the explorer is additive and merges into the live scope; a
  study launch with the same scope as a running session does not reset it. Every scope change
  drops the queue so the next fetch auto-starts. Excluded scopes render as chips too, on their
  own row — a silent exclusion is indistinguishable from an empty vault. The empty state names
  the filter that emptied the session rather than claiming the day is done. `fb-trainer-read-only`
  is vault-scoped because it is about this vault's reading positions.
- **Re-fetch on tab activation only when no session is running** — mid-session a refetch
  would clear the queue to loading and reset the progress bar. The diary summary is recorded at
  session end only when opted in, best-effort, and swallowed on failure (the server derives it
  idempotently from `ReviewLogs`).

### Graph (`views/graph/`)

- **Drop links whose endpoints are not in the node set**, both when building the data and
  after every filter — react-force-graph-2d crashes with "node not found" on an orphan.
- **Mass comes from `links`, not raw edges**, computed once in `buildGraphData` rather than in
  the visible subset: a tag's mass is a property of the vault and must not change because a
  folder was toggled off. The system deck links to nearly every standalone card, so it gets its
  own toggle like Origin folders.
- **`themeVer` in the colour memo's deps is load-bearing.** Every value comes from
  `getComputedStyle`, a dependency React cannot see; drop it and the graph keeps the previous
  theme's colours.
- **The animation loop is on-demand.** react-force-graph exposes no repaint call, so
  `autoPauseRedraw` is toggled off for a short window after load, hover or selection while the
  per-node lerps (entrance fade ~700ms, hover scale, focus dim ~800ms) settle. Per-node state is
  mutated in the paint loop and never triggers renders.
- **Force tuning** (`forces.js`): short-range repulsion for local legibility, collide as the
  no-overlap floor, links plus a weak inward pull for clumping — unbounded repulsion produced an
  evenly scattered field where no community could form. Overriding link strength discards d3's
  1/min(degree) heuristic, so degree is recomputed and kept as the base. Learnedness shortens
  and stiffens edges and pulls nodes inward, so mastered material contracts into knots.
- **Halos** (`paint.js paintHalos`) are one blended pass beneath links and nodes so neighbouring
  halos merge into a lit region. Size from mass, opacity from the learned rate, on separate
  channels so "a lot, half-known" out-reads "a little, perfectly known". `lighter` blending
  only on a dark ground — on a light theme it washes out, so overlaps darken instead. Bloom is
  opt-in because a wide soft gradient is the one part that reads as a literal glow.
- **Links rest in one neutral colour and regain relation colour only when a hover/selection
  isolates a subgraph**; resting alpha falls with density. A severed connection is dashed rather
  than coloured. Labels appear only past a zoom threshold on large graphs — text is the most
  expensive thing per frame.
- **The standalone HTML export restates the halo maths** (`export.js`), so `HALO_BASE`/
  `HALO_MAX` are embedded and `tests/ui.graph.test.js` checks they are.
- The progress-scope picker is a bar of its own above the canvas, not a row in the 184px
  floating panel; viewing someone else goes through an admin-only route an older server lacks,
  so the panel only renders on success and a "back to mine" button exists for the 404 case.

### Seal (`views/seal/`)

- **Reload the depth the user had paged to** on tab re-activation, not page one.
- Changed files are split into documents and metadata rather than interleaved — seeing
  `chapter.md` and `chapter.md.flashback` as two opaque siblings was the confusion this view
  had. Said once at the top of the timeline why highlighting a page shows up as a change to a
  file never opened.
- **Rollback is the Author's alone and hidden, not disabled** — it rewinds the workspace for
  everyone on a server and is not undoable from inside the app. Post-rollback the derived index
  diverges from the restored sidecars and `sealTools.inspect()` is blind (HEAD == workdir), so
  the banner offers the Doctor's `syncIndex` inline; after either, `invalidateData()` refreshes
  every DB-backed view.
- **Doctor:** diagnosis is an admin's, repair is the Author's — a rebuild discards everyone's
  review history. The admin sees the drift and a sentence naming who can act. The rebuild
  confirmation token stays untranslated because it is retyped verbatim.

### Explorer (`components/document/explorer/`)

- **A drop is a move**, never a reorder (`dragDrop.js`); a drag that only reordered the view
  would lie about what landed. Anki packages need a field→slot mapping before anything is
  created, so an `.apkg` drop opens `AnkiMappingModal` rather than importing.
- Per-folder progress is one call per level alongside the listing; its failure is silent — a
  missing indicator is a smaller loss than a tree that refuses to open. A folder that mounts
  already open (after a tree refresh) fetches its children immediately; `treeVersion` is bumped
  after a rollback/sync so every open folder remounts.
- **The context menu and the header buttons are gated by the same capabilities and hide
  rather than disable** — a Reader's sidebar should read as a reading sidebar, and the two
  cannot disagree. Reserved names (`names.js reservedNameError`) are refused at rename time.
- Renames and moves relocate open tabs and drafts (`useOpenTabs.relocateTabs`) so a later save
  writes to the new location instead of failing against the old one.

### Document editor (`components/document/`)

- **Capabilities are read from the registry, not the component**, because the tab bar and
  the selection toolbar render before the lazy chunk arrives. For markdown/text the highlights
  *are* the body, so annotating is the same `PUT /file` as editing — which is why
  `supportsHighlight` is computed *after* `canEditBody`, not before.
- **Reconciliation happens during render, not in effects** (`tabsState.js`): resetting the
  selection and inspector on file change, remapping path-keyed drafts on a move, pruning drafts
  for closed tabs. An effect commits one frame first, which painted the previous document's
  state under the new one's heading. Each block converges because the marker is set to the very
  identity that triggered it and the updaters return `prev` when nothing changes.
- **One highlight is one save and one commit.** Clicking the colour a highlight already has is
  a no-op; removal is only ever explicit and confirms when cards are linked. The card form is
  fed by a snapshot draft, not the live selection, which collapses the moment a field is clicked.
- **`useHighlightableRenderer`** captures the etag when content *loads*, not at save time —
  the question a save asks is "has anything changed since I started typing"; the server compares
  only the body half, so a card added through the Inspector meanwhile merges. It never persists
  a path whose content has not loaded (the editor would be empty), keeps the draft on a refused
  save, and goes read-only rather than hiding Save. Overwrite re-sends without a version.
- **`ReadingBar` is imported statically** and built by the editor; `ownsReadingBar` decides
  only *where* it mounts. The bar shows two facts: the track is the furthest mark (only
  advances), the text is where you are (moves both ways). The resume notice sits in front of the
  controls rather than replacing them, because the document that most needs its mark corrected is
  one already read into.
- **`useReadProgress`** debounces writes but not the readout; a lost position is not worth
  interrupting reading over. The "has the reader moved" guard lets one report through and then
  stands down, or it becomes a blind spot anchored to the resume position. Manual marks are what
  let the furthest mark move backwards.
- Inspector tabs list newest first (the sidecar appends) and the `#n` badge keeps creation
  order. Delete and edit are single server calls rather than read-modify-write of the sidecar,
  which reverted anything else written in between. The Inspector's edit glyphs hide for a Reader
  but "source" stays, since that is what a Reader came for.

### Renderers (`components/document/renderers/`)

- **Markdown:** `flashback://` links render with `data-flashback-hash` and no `href`, so
  Chromium never sees the protocol and cannot pass it to `shell.openExternal`; the
  `flashback-navigate` IPC is the fallback if one reaches main's `will-navigate`. The link
  extension must be registered after Markdown to override its schema.
- **Clip:** the container is populated imperatively so injected `<mark>`s survive renders;
  highlights anchor by character offset (`ranges.js`). Assets are identified by `data-href`
  (`media.js rewriteMedia`), and links to sound files are marked as media too — most of the web
  publishes audio as an `<a>`. The hover-to-save button hides on a delay (it sits outside the
  body), dismisses on scroll and zoom (the captured rect is stale), and skips tiny images. An
  inline `data:` image cannot be attached. Saving is sidecar-only; the body changes only through
  `saveClipAsset`. Its position is a scroll fraction, like Markdown's.
- **PDF:** nothing the renderer owns scrolls — the editor's ancestor does — so page-on-screen
  and scroll listening both come from `findScroller`, and `scale` is a dependency because a short
  PDF acquires a scroller only when zoom makes it overflow. The rubber band is `position: fixed`
  inside the zoomed shell, so `uiZoom` is captured at mousedown and a zoom mid-drag abandons the
  drag; converting to PDF units divides out both `scale` and `uiZoom`. Pages render lazily via an
  observer that keeps observing so zoom can bring new pages in. pdf.js fetches the file itself,
  so the token rides the query string (`api/documents.js rawDocumentUrl`).
- **EPUB:** everything `wireRendition` closes over is a ref, because it is wired once per load.
  The stored position is the unrounded percentage — rounding coarsens the mark the reader API
  bounds with — and is reported *absent* until epub.js has built its locations index, since it
  reports `0` rather than `undefined` before then and a finite 0 would be stored and defended.
  The CFI resumes the renderer, the spine `href` addresses `/api/reader`; both are stored so
  neither is converted. The initial `display()` is left alone and the resume jumps afterwards.
  Selection lives inside the section iframe and is bridged out via `onExternalSelection`; a
  clicked figure offers a card, a drag that ends on an image is a selection, and an unresolvable
  figure stays silent rather than attach the wrong one.
- **YouTube:** the player runs in the API's `/embed/youtube` proxy page on a real
  `http://localhost` origin, because YouTube's referrer/origin check fails on `file://` (Error
  153). Only messages from our own iframe are trusted; error codes 100/101/150 (removed,
  private, embedding disabled) surface a link out. Resume seeks without playing — reopening a
  document is not a request to play it. Position unit is `segment`, addressed by seconds, the
  same vocabulary `/api/reader` uses; highlights are timestamps made by "Mark this moment", so
  `toggle` is a no-op.
- **`highlights.js`:** ids are 9 base36 chars (~47 bits) — unique per document, short enough
  not to bloat the inline HTML. Highlights that cannot be anchored are dropped, never guessed.

### Flashcard components (`components/flashcard/`)

- **`Flashcard` is presentation-only and fully controlled**; the parent owns the face. A
  `type_answer` front ignores clicks — Check is the only reveal — and the back shows the
  compared answer then the notes. Static previews do not autoplay audio unless the caller opts
  in (the Anki mapper does).
- **Categories are vault data**, edited in Manage, never a constant. A new card defaults to
  the first (most foundational) entry; an existing card keeps what it had, including a category
  since deleted, which the select still lists so it survives a save.
- **Editing is text-only**; media is preserved server-side, so the upload slots hide and the
  preview shows the stored media through `resolveMedia`. A pre-split `type_answer` card is seeded
  through `flashcardFields.js` so saving normalises it.
- **A picked asset becomes a `File`.** A book figure comes through `/api/reader/image`, a clip
  asset through `/api/reader/media-file` (saved into the vault first — a no-op when already
  saved), and from there nothing downstream can tell it from one picked off disk. A clip offers
  sound too, so its picker also appears on audio slots.

### Other views

- **Decks:** the system deck always leads. Name and description are edited together, since
  blur-to-commit cannot work once moving between two fields is normal. Purge is a separate
  action from Delete because it destroys cards. Opening a deck from search stays an effect on
  purpose — it relays an event to the parent, which cannot happen during render, and clears the
  request so the same deck can be searched twice. Anki imports go through the mapping modal;
  every import broadcasts `invalidateData()`.
- **Flashcards:** the health filter is a filter on the list, not an inbox. Rows hold their own
  delete button so they carry `role="button"` rather than being one. Deleting names the source
  document rather than sending the user to the Inspector.
- **Stats:** heatmap days are local calendar days (the server buckets with `localtime`), so
  the grid walks local days; a UTC stride would offset everyone off UTC by a cell. Re-pulled on
  focus because the Trainer changes the numbers. Two explicit columns pair each tall panel with
  a short one — editorial, not masonry.
- **Diary:** `EntryEditor` resets during render keyed on `(date, content)` — `key={date}` is
  not enough because the content arrives asynchronously after the remount. The privacy note
  renders only on a remote. Pass rate excludes learning-phase cards on schema v2 summaries.
- **Config:** `mcpDiaryAccess` persists immediately because it is a cross-process
  authorization boundary the API reads from disk, and the legacy boolean is normalised to the
  tri-state. The vault name and path are read-only here and deliberately the only mention of
  vaults — editing the name used to rename the folder without moving the database. The AI
  Assistant block says "diary" regardless of connection: it gates the local MCP server against
  the local vault.
- **Setup:** identity is fetched over IPC because the API does not exist yet; only the name
  is pre-filled (the suggested address is a `.local` placeholder). The algorithm is written to the
  global pref key because the vault has no id yet, and `prefs.js` copies it forward. Blank
  identity writes no `user` at all.
- **Server:** the one place that says out loud what the role hides elsewhere. The role select
  never offers what the server would refuse (`roles.js`), and the account-limit message is
  shown before the form fails. Manage keeps categories visible without the role, since they
  classify what a Reader studies; it refetches on focus because views stay mounted.

---

## Design language

The interface follows **Tactile Learner**: Flashback as a study desk, where the source lies
open, the card is what you make from it, and the app says plainly what each review did. It
refines the skeuomorphic workspace the app already had (cream paper, amber ink, Didact Gothic)
and removes clutter; it does not replace it. Every screen was decided in a prototype first
(the "Flashback Tactile Learner" artifact); the per-area notes below record what each view
took from it.

Principles: a calm workspace; objects with weight; a diagnosis disguised as a game (a review
says what changed, never how well you did); the card as the signature unit; classically
educated (a card cites its source and carries a byline only when someone else wrote it);
warmth, taken seriously.

These are **preferences, not rules** — defaults to reach for that can give way when a screen
has a good reason:

- A metaphor only where it maps to a real action; elsewhere software conventions win.
- Weight from edge, shadow and radius (the card is 8px), never decoration: no ruled lines, no
  props, nothing hand-drawn.
- A surface carries only what is relevant there.
- One accent, for state. Colour belongs to the person's content, not to categories: file
  types are told apart by shape. (The graph's categorical dots are the deliberate exception.)
- Every colour is a theme token, and themes decide.
- Didact Gothic for content and interface; Geist Mono for data — counts, paths, citations and
  small section labels. Both are bundled (`@fontsource/*`, imported in `index.jsx`), so the
  packaged app renders them offline.
- Words and typographic marks, never emoji or pictographs.
- Quiet controls, bold indicators.
- Information small and where it is used: a tiny count and a thin line rather than a filled
  badge; detail in the tooltip; secondary actions on hover.
- The content gets the space; occasional tools are layers that close when done, not columns.
- Constant settings in view, occasional ones behind one button that sums up their state.
- Compact, not snobbish.
- The title bar names the screen; a page repeats it only when it needs an anchor (report-like
  pages keep a heading, tool screens don't).
- Motion shows physical cause, stays short, never makes input wait, and respects reduced
  motion.

## Theme tokens

### How it works

Themes are driven by a `data-theme` attribute on `<html>`. Every colour in the application is a
CSS custom property declared per `[data-theme="…"]` block in `src/ui/index.css`; setting the
attribute is the whole switch. The built-in themes are the names in `src/ui/themes.js` —
`light-workbench`, then each dark theme twice: `dark-workbench`, `dark-cherry`,
`raven-indigo` and `focus-blue` are the **Focus** variants (the card a step darker than the
desk) and `<id>-lamp` the **Lamp** variants (the card a step lighter) — and `light-workbench`
doubles as the `:root` fallback. `themeLabel(t, id)` in the same file is the display name
("Dark cherry · Lamp"); a custom theme's id is its name. A Lamp block is a full copy of its
Focus block with the card values changed, not an override, because the contrast check reads
each block on its own. User-defined themes come from
`src/ui/customThemes.js`: the theme editor in Config writes `{ name, colors }` to localStorage
and injects it as another `[data-theme]` rule at startup; `THEME_VARS` there is the list of
variables the editor exposes.

`App.jsx` owns the active theme (`fb-theme` in localStorage, applied before first render) and
nothing else reads the theme name — components branch on nothing; the cascade does the work.
The one JavaScript reader of colour values is the graph (`views/graph/palette.js`), which
reads its palette through `getComputedStyle` once per theme change (`hooks/useThemeVersion.js`)
because it paints a canvas.

### The tokens and what each is for

Every colour token has exactly one job, because a token asked to do two jobs at opposite ends
of the theme cannot satisfy both. The families:

| tokens | job |
| --- | --- |
| `--color-bg-base` / `-sidebar` / `-surface` / `-hover` / `-reader` / `-title-bar` / `-sidebar-header` | the surfaces |
| `--color-bg-editor` | `light` or `dark`, the scheme the TipTap editor uses |
| `--color-fg-primary` / `-secondary` / `-icon` | text and inactive icons |
| `--color-accent`, `--color-accent-subtle`, `--color-on-accent` | the active colour, its tint, and the label on an accent fill |
| `--color-border`, `--color-border-strong`, `--color-tree-indent` | hairlines; controls; the tree guide |
| `--color-hl-1..4` | highlight swatches painted behind document text |
| `--color-review-again/hard/good/easy`, `--color-on-review` | the grade buttons and the summary |
| `--color-graph-document/folder/flashcard/tag/deck`, `-link`, `-disconnect`, `-inherit`, `-edge` | the graph's categorical palette |
| `--color-card`, `-card-edge`, `-card-ink`, `-card-ink-2`, `-card-line`, `-card-field`, `-card-pile`, `-card-pile-edge`, `--shadow-card` | the flashcard as an object: its stock, edge, text, dividers, answer field, the pile of backs under it, and its shadow |
| `--color-pop-halo` | the soft halo behind a grade pop in the Trainer |
| `--color-kraft`, `-kraft-edge`, `-kraft-print` | the kraft box a group of cards sits in; print is the count on it |
| `--color-box-slate/sage/ochre/brick/plum/ink` | bookcloth tones a deck's box can take (kraft is the default deck's) |
| `--color-danger`, `--color-danger-bg`, `--color-on-danger` | errors; danger fills and the label on them |
| `--color-scrim` | the backdrop behind a dialog |
| `--shadow-sm`, `--shadow-float` | resting and floating elevation |

Four pairs are easy to get wrong:

- **`--color-review-*` is a button fill and a text colour.** It fills the Trainer's grade
  buttons *and* colours text on a panel (the session summary, the type-answer verdict). The two
  roles only agree when the label painted on the fill is `--color-on-review`, set to the
  theme's panel colour — then "label on fill" and "swatch as text on panel" are the same
  contrast pair and one value satisfies both. Never label a grade button with `--color-fg-primary`.
- **`--color-hl-*` is painted behind document text**, so `--color-fg-primary` must stay
  readable on top: pale swatches in a light theme, deep ones in a dark theme. The highlight
  picker's dots are derived from these, not the other way round.
- **`--color-border` is a hairline** for dividers and card edges. A control whose boundary is
  the only thing identifying it — an input, a select, `.field` — uses `--color-border-strong`,
  which clears 3:1 against the surface behind it.
- **`--color-card*` is not `--color-bg-surface`.** The card is an object on the desk, not a
  panel: its stock, ink and edge are their own tokens so a theme can make the card darker than
  the desk (Focus) or lighter (Lamp) without moving a single panel. `card-ink-2` carries the
  source and notes and is checked at 4.5:1 on the card like body text.
- **`--color-kraft-print` is checked as text** (4.5:1 on kraft). The count on a box is how
  many cards sit behind the highlight, so it is legible ink, not a faint stamp.
- **`--color-graph-*` is a categorical palette, not a set of aliases.** Five node types are
  bare dots on `--color-bg-base`, so colour is the only thing telling them apart: each theme's
  five hues are spread around the wheel *and* stepped in lightness, which makes them read as
  one set while staying separable. The lightness ladder is not decoration — under protanopia and
  deuteranopia the hue differences collapse and lightness is the only cue left, so flattening it
  is what breaks the palette first. Chroma rises as lightness falls; holding it flat makes the
  dark end read as mud. Slot 1 (Document) sits on the theme's accent hue, Tag stays green and
  Flashcard warm, so the graph reads the same way whichever theme is on. `dark-cherry` is the
  deliberate exception: a narrow blossom palette (cards cherry red, documents blossom pink,
  folders bark) that separates red from pink by lightness and chroma instead of hue. Aliasing
  these back to `--color-hl-*` or `--color-review-*` re-breaks them — those are tuned against
  text, not against the canvas. The values must be literal hex: the graph parses hex/rgb only,
  so `color-mix()` will not work there.

The dark themes' danger colour is a light red, which is why `--color-on-danger` is dark there:
white on it was the one pair that had never been checked.

### light-workbench

Its surfaces are a pastel beige carried by chroma rather than darkness, and that is not a style
preference: `--color-accent` is frozen at the sRGB gamut edge for its hue (C = 0.146 of 0.150
available) and its 4.5:1 requirement against both the window and the panel puts a hard floor
under every surface either one touches. `bg-base` has about two luminance points of room, so
a *darker* beige is not reachable without changing the accent contract — a more chromatic one
at the same luminance is, and reads as the same warmth. `bg-base`, `bg-surface` and
`accent-subtle` are therefore solved backwards from the ratio each must clear against the
accent, not hand-picked; nudging their lightness is what will break the contrast check first.
One token serves both link text and button fills, so the accent cannot be brightened toward the
dark theme's amber without splitting that role in two.

### The check

`npm run check:contrast` (`scripts/check-contrast.js`) parses the theme blocks out of
`index.css` and asserts every pair the UI actually renders: text on each surface, accent and
`on-accent`, danger and `on-danger`, the review pairs, `fg-primary` over each highlight, and
pairwise OKLab ΔE floors between the five graph hues (15 normal / 8 under colour-vision
deficiency). It runs in `check:ui`. It reads with a regex, which imposes a shape on the file:
each theme block starts `[data-theme="…"] {` at column 0 and ends with `}` at column 0, every
`--color-*` is one `name: value;` line with a literal hex (a `var()` chain is followed, up to
five deep), no `}` is nested inside a block, and the `:root, [data-theme="light-workbench"]`
selector stays joined. The bare `:root` size block is skipped, which is why non-colour tokens
may live there freely.

### Rules

- Never hardcode a colour in a component stylesheet or in JSX. Every colour is a token; the
  guard fails otherwise. The exceptions are the graph's standalone HTML export (a page that
  runs outside the app) and the per-filetype fills in `components/icons/`.
- Never read the theme in JavaScript. Components must not branch on the theme name.
- A new colour token is added to every theme block at once, to `THEME_VARS` in
  `customThemes.js` and to `DARK_DEFAULTS` in `views/config/themeDefaults.js` so the editor
  offers it, and — when it is a text/background pair — to `TEXT_PAIRS` in `check-contrast.js`.
- Keep the pair notes beside the values in `index.css` short; the reasoning is here.
