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

The client is initialized once on startup with the base URL received from Electron via IPC. After that it is a transparent request wrapper.

**Startup flow:**

```
Electron main  →  ipcMain.handle('get-api-url')  →  reads config.json  →  returns URL
React renderer →  window.flashback.getApiUrl()   →  initClient(url)    →  app renders
```

The preload script (`src/electron/preload.cjs`) bridges IPC to the renderer using `contextBridge`. The renderer never imports from `electron` directly. The `.cjs` extension is required because Electron's sandboxed preload context is CommonJS-only — it does not support ES module `import` even when the project has `"type": "module"` in `package.json`.

**Exports:**

- `initClient(url)` — called once in `index.jsx` before the React tree mounts.
- `request(method, path, body?)` — JSON request, throws on non-2xx.
- `upload(path, formData)` — multipart upload, throws on non-2xx.

Errors thrown by `request` and `upload` carry a `.status` property so callers can branch on 400 vs 404 vs 500 without parsing message strings.

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
```

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

`index.jsx` is the only place where startup sequencing happens. It calls `getApiUrl()` over IPC, initializes the client, then mounts the React tree. Nothing renders until the URL is known.

```js
const url = await window.flashback.getApiUrl();
initClient(url);
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

Shared, presentational components with no server state and no API imports. They receive data as props and call callbacks to report events upward.

A component in `components/` must be usable from any view without modification.

### File naming

| What                          | Convention                |
| ----------------------------- | ------------------------- |
| View files                    | `PascalCaseView.jsx`    |
| Shared components             | `PascalCase.jsx`        |
| API modules                   | `camelCase.js`          |
| Per-component styles (if any) | `PascalCase.module.css` |

---

## IPC Surface

The preload script exposes exactly one namespace: `window.flashback`. New IPC channels must be added to both `preload.js` (as a `contextBridge` method) and `main.js` (as an `ipcMain.handle` handler). The renderer never imports from `electron` directly.

Current channels:

| Channel         | Direction        | Purpose                                                    |
| --------------- | ---------------- | ---------------------------------------------------------- |
| `get-api-url` | renderer → main | Get the API base URL derived from config.json              |
| `get-config`  | renderer → main | Read the full config.json object                           |
| `set-config`  | renderer → main | Write a new config.json object; returns `{ ok, error? }` |

---

## What Does Not Belong in the UI Layer

- Filesystem access of any kind (all file operations go through the API).
- SQLite queries or direct database references.
- Business logic (SRS scheduling, sidecar merging, tag propagation). The API owns all of this.
- Hardcoded port numbers or API paths outside of `api/client.js` and `api/*.js`.
