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

The client is initialized once on startup with the base URL **and API token** received from Electron via IPC. After that it is a transparent request wrapper that attaches `Authorization: Bearer <token>` to every request.

**Startup flow:**

```
Electron main  →  ipcMain.handle('get-api-url' / 'get-api-token')  →  reads config.json  →  returns URL + token
React renderer →  window.flashback.getApiUrl()/getApiToken()       →  initClient(url, token)  →  app renders
```

The preload script (`src/electron/preload.cjs`) bridges IPC to the renderer using `contextBridge`. The renderer never imports from `electron` directly. The `.cjs` extension is required because Electron's sandboxed preload context is CommonJS-only — it does not support ES module `import` even when the project has `"type": "module"` in `package.json`.

**Exports:**

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
```

(Not every domain is listed here — `decks`, `highlights`, `categories`, `search`, `flashcards` each have a sibling module too.)

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

Views are the only layer allowed to use React hooks and own server state. Each view file corresponds to one full screen of the application.

```
views/DocumentsView.jsx
views/FlashcardsView.jsx
views/GraphView.jsx
```

### State ownership

Server state (data fetched from the API) lives in TanStack Query hooks. Local UI state (which panel is open, current selection) lives in `useState` or `useReducer` inside the view.

**Do not lift server state into a parent component or React Context.** Each view fetches its own data. This scopes re-renders and makes views independently loadable.

### TanStack Query conventions

```js
// Reading — data is cached and shared across the view
const { data, isLoading } = useQuery({
  queryKey: ['folder', path],
  queryFn: () => listFolder(path),
});

// Writing — invalidate the relevant query key on success
const { mutate } = useMutation({
  mutationFn: ({ name, parentPath }) => createFile(name, parentPath),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['folder', path] }),
});
```

Query keys must be specific enough that invalidation is targeted. A key of `['folder']` invalidates everything; `['folder', path]` invalidates only the affected folder.

---

## App Shell (`src/ui/App.jsx`)

`App.jsx` owns the top-level navigation state (which view is active) and nothing else. Views are lazy-loaded with `React.lazy` and wrapped in `Suspense` so they are only bundled and fetched when first visited.

```js
const DocumentsView  = lazy(() => import('./views/DocumentsView'));
const FlashcardsView = lazy(() => import('./views/FlashcardsView'));
const GraphView      = lazy(() => import('./views/GraphView'));
```

`App.jsx` does not fetch data, does not hold server state, and does not know what the active view renders. It only switches between views.

---

## Entry Point (`src/ui/index.jsx`)

`index.jsx` is the only place where startup sequencing happens. It calls `getApiUrl()` and `getApiToken()` over IPC, initializes the client, then mounts the React tree. Nothing renders until the URL is known.

```js
const url = await window.flashback.getApiUrl();
const token = await window.flashback.getApiToken();
initClient(url, token);
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
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

- it is demonstrably slow to render, **and**
- its props can be made stable (objects and functions must be memoized with `useMemo`/`useCallback` before being passed in).

`useMemo` and `useCallback` on their own have a cost. They are only valuable when they prevent a downstream re-render.

### 3. Virtualize long lists

Any list that can grow beyond ~100 rows (file tree, review history, search results, graph node list) must use **TanStack Virtual**. Rendering 500 DOM nodes at once is slow regardless of React optimizations.

### 4. Code-split at the view boundary

Views are already lazy-loaded in `App.jsx`. Do not lazy-load individual components within a view — the overhead is not worth it at that granularity.

### 5. Derive

If a value can be computed from existing state or query data, compute it during render. Do not sync derived values into `useState` — it creates two sources of truth and introduces update timing bugs.

---

## Component Conventions

### `src/ui/components/`

Components are grouped by the view they belong to. A component used by only one
view lives in that view's feature folder; a component reused across views lives
in `shared/`.

```
components/
  AppGate.jsx            App-shell gate — blocks rendering until the API answers
  shared/                Generic, reusable across any view (ContextMenu, ProgressDialog)
  icons/                 SVG icon components + fileIconMap
  documents/             Everything for the Documents view
    DocumentEditor.jsx     Editor shell (tabs, selection toolbar, dirty/draft state)
    FileExplorer.jsx       Workspace file tree
    EditorTabBar.jsx
    SelectionToolbar.jsx
    HighlightRemoveDialog.jsx
    inspector/             Inspector panel and its tabs (Cards, Highlights, …)
    renderers/             Per-filetype editors (Markdown, Text, …) + helpers
```

**Rules:**

- A component used by exactly one view belongs in that view's folder, next to
  the component that owns it — not in a flat shared pool.
- A component used by two or more views belongs in `shared/` and must be usable
  from any view without modification.
- `shared/` and `icons/` components are presentational: no server state. (View
  feature components may import from `api/` — e.g. `FileExplorer`, the Inspector
  tabs, and the renderers do.)
- Import depth from a feature folder: `../../api/...` from `documents/`,
  `../../../api/...` from `documents/inspector/` and `documents/renderers/`.

### File naming

| What                          | Convention                |
| ----------------------------- | ------------------------- |
| View files                    | `PascalCaseView.jsx`    |
| Shared components             | `PascalCase.jsx`        |
| API modules                   | `camelCase.js`          |
| Per-component styles (if any) | `PascalCase.module.css` |

---

## Renderers & the Highlight Contract

`components/documents/renderers/` holds one editor per file type plus the shared
highlight machinery. `DocumentEditor` chooses a renderer by extension
(`pickRenderer`) and talks to it through a fixed prop contract — it never imports
TipTap or touches an editor instance directly.

### The renderer prop contract

Every renderer receives the same props from `DocumentEditor`:

| Prop                 | Direction        | Purpose                                                                 |
| -------------------- | ---------------- | ----------------------------------------------------------------------- |
| `path`               | in               | Active file path; changing it loads a new document.                     |
| `draftContent`       | in               | Unsaved body to restore, or `undefined` to load from disk.              |
| `saveRef`            | out (ref)        | Set to `(metaTransform?) => Promise` so the parent can trigger a save.  |
| `highlightRef`       | out (ref)        | Set to the highlight command object (see below), or `null` if unsupported. |
| `onDirtyChange`      | callback         | `(path, isDirty)` — drives the tab's dirty dot.                         |
| `onDraftChange`      | callback         | `(path, body \| undefined)` — body on edit, `undefined` once saved.     |
| `onHighlightsChange` | callback         | `(path, highlights[])` — registry after load and after each save.       |
| `onSidecarRefresh`   | callback         | `(path, metadata)` — full sidecar after load/save (cards, tags, …).     |

A renderer that supports highlighting also exposes a **static** flag so the
parent can enable the highlight toolbar without knowing the renderer's identity:

```js
MyRenderer.supportsHighlight = true;
```

### Building a highlightable renderer

Editor-backed renderers do **not** re-implement the load/save/dirty/draft
lifecycle. They call `useHighlightableRenderer`, which owns all of it (including
the empty-state save guard and Ctrl+S) and delegates only what differs:

```js
const { editor, loading } = useHighlightableRenderer({
  ...props,
  extensions,                 // the editor's extension list
  editorClass,                // class on the ProseMirror node
  serialize:   (editor) => …,        // editor → body string written to disk
  loadContent: (editor, body, meta) => …, // body (+ anchored highlights) → editor
  reconcile:   (editor, existing) => ({ highlights }), // live editor → registry
});
```

The caller renders its own `<EditorContent>` wrapper, so markup and CSS stay
per-renderer. `MarkdownRenderer` and `TextRenderer` are the reference
implementations: markdown anchors highlights **inline** (`<mark data-hl>`, no
load-time apply step); plain text anchors them by **character offset** in the
sidecar and re-applies on load.

### The highlight command contract

`highlightRef` is the only highlight surface `DocumentEditor` depends on — a
plain object, not a TipTap reference. `createHighlightCommands(editor)` in
`highlights.js` is the TipTap implementation; a non-TipTap renderer (PDF,
CodeMirror, …) can supply its own object of the same shape:

| Method               | Returns                                              | Used by                  |
| -------------------- | --------------------------------------------------- | ------------------------ |
| `toggle(color)`      | `{ kind: 'created'\|'recolored'\|'removed', id }`   | color dots               |
| `unset()`            | `{ kind: 'removed', id }` \| `null`                 | the ✕ button             |
| `ensure(color?)`     | `{ kind: 'existing'\|'created', id }` \| `null`     | Card / Ref buttons       |
| `currentId()`        | the highlight id under the selection, or `null`     | orphan-removal check     |
| `scrollTo(id)`       | scrolls the view to that highlight                  | Highlights tab jump      |

The sidecar `highlights[]` registry shape is documented in `DATAMODEL.md`; it is
uniform across anchoring strategies (offset fields are simply absent for inline
anchoring), so the Inspector, cards (`location: { type: 'highlight', id }`), and
Highlights tab work with any renderer unchanged.

---

## IPC Surface

The preload script exposes exactly one namespace: `window.flashback`. New IPC channels must be added to both `preload.js` (as a `contextBridge` method) and `main.js` (as an `ipcMain.handle` handler). The renderer never imports from `electron` directly.

Current channels:

| Channel         | Direction        | Purpose                                                    |
| --------------- | ---------------- | ---------------------------------------------------------- |
| `get-api-url`      | renderer → main | Get the API base URL derived from config.json              |
| `get-api-token`    | renderer → main | Get the API bearer token from config.json (for `initClient`) |
| `get-config`       | renderer → main | Read the full config.json object                           |
| `set-config`       | renderer → main | Write a new config.json object; returns `{ ok, error? }` |
| `window-minimize`  | renderer → main | Minimize the window                                        |
| `window-maximize`  | renderer → main | Maximize or unmaximize the window                          |
| `window-close`     | renderer → main | Close the window (hides to tray unless quitting)           |

---

## What Does Not Belong in the UI Layer

- Filesystem access of any kind (all file operations go through the API).
- SQLite queries or direct database references.
- Business logic (SRS scheduling, sidecar merging, tag propagation). The API owns all of this.
- Hardcoded port numbers or API paths outside of `api/client.js` and `api/*.js`.

---

## Theme System

### How it works

Themes are driven by a `data-theme` attribute on `<html>`. All colors in the application are
CSS custom properties — no component stylesheet may use a hardcoded color value. Setting
`document.documentElement.setAttribute('data-theme', name)` is the only action needed to
switch themes; every component inherits the new palette automatically via CSS cascade.

### CSS variables

All variables are declared in `src/ui/index.css`. Every theme must define all of them.

| Variable | Semantic meaning |
|---|---|
| `--color-bg-base` | Window / outermost background |
| `--color-bg-sidebar` | Activity bar background |
| `--color-bg-surface` | Panels, cards, content areas |
| `--color-bg-hover` | Hover state on interactive elements |
| `--color-fg-primary` | Primary text |
| `--color-fg-secondary` | Muted / secondary text |
| `--color-fg-icon` | Inactive icon tint |
| `--color-accent` | Active indicator, links, focus rings |
| `--color-border` | Dividers and outlines |
| `--color-title-bar` | Drag region background |
| `--color-accent-subtle` | Very low-opacity accent tint — selected item backgrounds, drag targets |
| `--color-tree-indent` | File tree indentation line — can be accent-tinted per theme |
| `--color-sidebar-header` | Header bar inside sidebar panels (distinct from sidebar body) |
| `--color-hl-amber` | Document highlight — amber swatch |
| `--color-hl-green` | Document highlight — green swatch |
| `--color-hl-blue` | Document highlight — blue swatch |
| `--color-hl-pink` | Document highlight — pink swatch |

### Built-in themes

`"light"` and `"dark"` are declared in `src/ui/index.css` as `[data-theme="light"]` and
`[data-theme="dark"]` blocks.

### Adding a theme

1. Add a `[data-theme="my-theme"]` block to `src/ui/index.css` that defines all ten variables
   listed above.
2. Append `"my-theme"` to the `THEMES` array in `src/ui/App.jsx`. The cycle toggle will
   include it automatically.

### User-defined themes

A user can define a custom theme without modifying the source. The Config view can accept a
theme name string from `config.json` and inject it into `THEMES` at startup, alongside loading
a user-provided CSS snippet that defines the `[data-theme]` block. The theme attribute
mechanism requires no changes — only the `THEMES` array and the CSS declaration need to exist.

### Theme state

- Active theme is persisted in `localStorage` under key `fb-theme`.
- On startup, `App.jsx` reads `localStorage.getItem('fb-theme') ?? 'light'` and applies it
  before first render.
- Theme state lives exclusively in `App.jsx`. No Context is needed because all styling is CSS.

### Rules

- **Never hardcode colors.** Every color value in every component stylesheet must reference a
  CSS variable from the list above.
- **Never read the theme in JavaScript.** Components must not branch on the theme name; use
  CSS variables and let the cascade do the work.
- **All new variables must be added to every theme.** If a new semantic slot is needed, add it
  to all `[data-theme]` blocks at the same time.
