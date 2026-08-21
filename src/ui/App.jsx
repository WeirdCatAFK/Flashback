import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import "./App.css";

import IconDocuments from "./components/icons/IconDocuments";
import IconFlashcards from "./components/icons/IconFlashcards";
import IconDecks from "./components/icons/IconDecks";
import IconGraph from "./components/icons/IconGraph";
import IconTrainer from "./components/icons/IconTrainer";
import IconConfig from "./components/icons/IconConfig";
import IconSeal from "./components/icons/IconSeal";
import IconManage from "./components/icons/IconManage";
import IconStats from "./components/icons/IconStats";
import IconDiary from "./components/icons/IconDiary";
import IconServer from "./components/icons/IconServer";
import { THEMES } from "./themes";
import { loadCustomThemes, injectCustomThemeCSS } from "./customThemes";
import AppGate from "./components/AppGate";
import SearchModal from "./components/search/SearchModal";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import OnboardingTour from "./components/onboarding/OnboardingTour";
import TitleBar from "./components/TitleBar";
import VaultManager from "./components/VaultManager";
import { relocatePath } from "./utils/relocatePath";
import { notifyUiZoomChanged } from "./utils/uiZoom";
import { invalidateData } from "./utils/dataBus";
import { useT } from "./translations/index.jsx";
import useConnection from "./hooks/useConnection.js";
import { SessionProvider } from "./session.jsx";
import { getPref, setPref, setActiveVaultScope } from "./prefs.js";

const ALL_VIEW_IDS = ['documents', 'flashcards', 'decks', 'graph', 'trainer', 'stats', 'diary', 'seal', 'manage', 'server', 'config'];

const DocumentsView  = lazy(() => import("./views/Documents"));
const FlashcardsView = lazy(() => import("./views/Flashcards"));
const DecksView      = lazy(() => import("./views/Decks"));
const GraphView      = lazy(() => import("./views/GraphView"));
const TrainerView    = lazy(() => import("./views/Trainer"));
const ConfigView     = lazy(() => import("./views/Config"));
const SealView       = lazy(() => import("./views/Seal"));
const ManageView     = lazy(() => import("./views/Manage"));
const StatsView      = lazy(() => import("./views/Stats"));
const DiaryView      = lazy(() => import("./views/Diary"));
const ServerView     = lazy(() => import("./views/Server"));

const NAV_ITEMS = [
  { id: "documents",  Icon: IconDocuments },
  { id: "flashcards", Icon: IconFlashcards },
  { id: "decks",      Icon: IconDecks },
  { id: "graph",      Icon: IconGraph },
  { id: "trainer",    Icon: IconTrainer },
  { id: "stats",      Icon: IconStats },
  { id: "diary",      Icon: IconDiary },
  { id: "seal",       Icon: IconSeal },
  { id: "manage",     Icon: IconManage },
  // Remote-only — filtered in the nav below. A local vault has one account, it is the
  // Author, and there is nobody to manage.
  { id: "server",     Icon: IconServer, remoteOnly: true },
];

/**
 * Labels live in a function of t, not in NAV_ITEMS. Two reasons, and both are the
 * standard shape for any module-level string table in this app:
 *
 *   1. A t() call at module scope evaluates once at import, so the nav would keep
 *      the old language after a switch.
 *   2. Holding the English in the constant and calling t(item.label) at render
 *      fixes that, but passes a variable — and scripts/translations-extract.js only reads
 *      string literals, so those keys would never reach a translator.
 *
 * Called during render, every key a literal: both problems gone.
 */
function navLabels(t) {
  return {
    documents:  t("Documents"),
    flashcards: t("Flashcards"),
    decks:      t("Decks"),
    graph:      t("Graph"),
    trainer:    t("Trainer"),
    stats:      t("Statistics"),
    // "Logs", not "Diary". On a shared server the entries sit in one git repo alongside
    // everyone else's and an admin can read them, so the private-journal name would be a
    // lie. The routes, the directory and the `fb-diary-enabled` pref keep their names —
    // renaming those would be a migration that silently reset everyone's opt-in.
    diary:      t("Logs"),
    seal:       t("Seal"),
    manage:     t("Manage"),
    server:     t("Server"),
    config:     t("Config"),
  };
}

export default function App() {
  const { t } = useT();
  const labels = navLabels(t);
  const [activeView, setActiveView] = useState("documents");

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("fb-theme");
    if (saved) return saved;
    // No explicit choice yet — follow the OS light/dark preference.
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark-workbench" : "light-workbench";
  });
  const [customThemes, setCustomThemes] = useState(() => loadCustomThemes());
  const allThemes = useMemo(() => [...THEMES, ...customThemes.map(ct => ct.name)], [customThemes]);

  // Inject custom theme CSS on startup and whenever custom themes change
  useEffect(() => { injectCustomThemeCSS(customThemes); }, [customThemes]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fb-theme", theme);
  }, [theme]);

  // The vault (or remote server) the app is currently pointed at. Changing it re-points
  // the API client and bumps connectionId, which is used as a remount key below.
  const { connection, connectionId } = useConnection();

  const [selectedPath, setSelectedPath] = useState(null);
  // Persist which folders are expanded so the tree reopens the way the user
  // left it on the next launch. Stored as a plain array of paths in localStorage,
  // scoped to the vault — these are vault-relative paths and mean nothing in another one.
  const [openPaths, setOpenPaths] = useState(() => {
    try {
      const saved = JSON.parse(getPref("fb-open-folders") ?? "[]");
      return new Set(Array.isArray(saved) ? saved : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    setPref("fb-open-folders", JSON.stringify([...openPaths]));
  }, [openPaths]);

  // Re-scope preferences and drop anything holding a path from the vault we just left.
  // The view tree itself is discarded by the connectionId key on AppGate; this covers the
  // App-level state that lives above it.
  useEffect(() => {
    if (!connection) return;
    setActiveVaultScope(connection.id ?? null);
    // A remote-only view has to be left behind when the app goes local, or the nav button
    // disappears while its panel stays on screen with nothing to show.
    setActiveView((current) => {
      const item = NAV_ITEMS.find((n) => n.id === current);
      return item?.remoteOnly && connection.kind !== 'remote' ? 'documents' : current;
    });
    setSelectedPath(null);
    setPendingSource(null);
    setPendingDeck(null);
    setStudySession(null);
    try {
      const saved = JSON.parse(getPref("fb-open-folders") ?? "[]");
      setOpenPaths(new Set(Array.isArray(saved) ? saved : []));
    } catch {
      setOpenPaths(new Set());
    }
    invalidateData();
  }, [connection?.id, connection?.url]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [studySession, setStudySession] = useState(null);
  const handleStartStudy = useCallback((session) => {
    setStudySession(session);
    setActiveView('trainer');
  }, []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [vaultManagerOpen, setVaultManagerOpen] = useState(false);

  // Feature tour ("onboarding"). Auto-runs once — the first time the app loads
  // after setup, and once for existing users upgrading — then only on demand from
  // Config. Gated purely by localStorage, never by config.json, so replaying it
  // can't re-trigger the setup wizard.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (!localStorage.getItem("fb-onboarding-seen")) setTourOpen(true);
  }, []);
  const handleCloseTour = useCallback(() => {
    localStorage.setItem("fb-onboarding-seen", "1");
    setTourOpen(false);
  }, []);

  const [pendingSource, setPendingSource] = useState(null); // { path, highlightId }
  const [pendingDeck, setPendingDeck] = useState(null); // deck global_hash to open from search
  const handleOpenDocumentSource = useCallback((documentPath, highlightId) => {
    setActiveView('documents');
    setPendingSource({ path: documentPath, highlightId: highlightId ?? null });
  }, []);

  const toggleOpen = useCallback((folderPath) => {
    setOpenPaths(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const relocatePaths = useCallback((oldPrefix, newPrefix) => {
    setOpenPaths(prev => {
      const affected = [...prev].filter(p => p === oldPrefix || p.startsWith(oldPrefix + '/'));
      if (affected.length === 0) return prev;
      const next = new Set(prev);
      for (const p of affected) {
        next.delete(p);
        next.add(newPrefix + p.slice(oldPrefix.length));
      }
      return next;
    });
    // Keep the active selection pointing at the moved/renamed file so its open
    // tab and any subsequent save follow it to the new location.
    setSelectedPath(prev => relocatePath(prev, oldPrefix, newPrefix));
  }, []);

  const [zoom, setZoom] = useState(
    () => parseFloat(localStorage.getItem("fb-zoom") ?? "1")
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-zoom", zoom);
    localStorage.setItem("fb-zoom", zoom);
    // Overlays anchored to a captured rect (selection toolbar, the renderers'
    // hover buttons) dismiss on this — the element they point at just moved.
    notifyUiZoomChanged();
  }, [zoom]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === '?') {
        const tag = document.activeElement?.tagName.toLowerCase();
        if (!['input', 'textarea', 'select'].includes(tag) && !document.activeElement?.isContentEditable) {
          e.preventDefault();
          setShortcutsOpen(o => !o);
          return;
        }
      }
      if (!e.ctrlKey) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setSearchOpen(o => !o);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom(z => Math.min(2, parseFloat((z + 0.1).toFixed(1))));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom(z => Math.max(0.5, parseFloat((z - 0.1).toFixed(1))));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSearchNavigate = useCallback(({ type, payload }) => {
    switch (type) {
      case 'document':
        setActiveView('documents');
        setPendingSource({ path: payload.path, highlightId: null });
        break;
      case 'folder':
        setActiveView('documents');
        setOpenPaths(prev => { const n = new Set(prev); n.add(payload.path); return n; });
        setSelectedPath(payload.path);
        break;
      case 'flashcard':
        if (payload.documentPath) {
          setActiveView('documents');
          setPendingSource({ path: payload.documentPath, highlightId: null });
        } else {
          setActiveView('flashcards');
        }
        break;
      case 'tag':
        handleStartStudy({ tags: [payload.name] });
        break;
      case 'deck':
        setActiveView('decks');
        setPendingDeck(payload.hash);
        break;
      default: break;
    }
  }, [handleStartStudy]);

  // Track which views have been visited so we only mount them on first visit
  const visitedRef = useRef(null);
  if (visitedRef.current === null) visitedRef.current = new Set();
  visitedRef.current.add(activeView);

  function renderView(view) {
    switch (view) {
      case "documents":  return <DocumentsView isActive={activeView === 'documents'} openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths} selectedPath={selectedPath} onSelect={setSelectedPath} onStudyFolder={(folder) => handleStartStudy({ folder })} openSource={pendingSource} onOpenSourceConsumed={() => setPendingSource(null)} />;
      case "flashcards": return <FlashcardsView />;
      case "decks":      return <DecksView onStudyDeck={handleStartStudy} openDeck={pendingDeck} onOpenDeckConsumed={() => setPendingDeck(null)} />;
      case "graph":      return <GraphView isActive={activeView === 'graph'} onNavigate={handleSearchNavigate} />;
      case "trainer":    return <TrainerView isActive={activeView === 'trainer'} studySession={studySession} onOpenSource={handleOpenDocumentSource} />;
      case "seal":       return <SealView isActive={activeView === 'seal'} />;
      case "manage":     return <ManageView isActive={activeView === 'manage'} />;
      case "stats":      return <StatsView isActive={activeView === 'stats'} />;
      case "diary":      return <DiaryView isActive={activeView === 'diary'} connection={connection} />;
      case "server":     return <ServerView connection={connection} />;
      case "config":     return (
        <ConfigView
          theme={theme}
          onThemeChange={setTheme}
          allThemes={allThemes}
          customThemes={customThemes}
          onCustomThemesChange={setCustomThemes}
          onReplayTour={() => setTourOpen(true)}
          connection={connection}
        />
      );
      default: return null;
    }
  }

  return (
    /* Wraps the WHOLE shell, title bar included: the role badge lives up there, and every
       view below asks `can()` before drawing a destructive control. Keyed on the connection
       so pointing the app somewhere else re-asks who you are there — the provider retries a
       few times, because a local vault switch restarts the API underneath it. */
    <SessionProvider key={`session-${connectionId}`} connectionId={connectionId}>
    <div id="app-shell">
      <TitleBar
        onSearch={() => setSearchOpen(true)}
        connection={connection}
        onManageVaults={() => setVaultManagerOpen(true)}
      />

      {/* Keyed on the connection so switching vault (or connecting to a remote) unmounts
          every view rather than leaving the previous vault's documents, cards and graph
          on screen — the view-slot keep-alive below would otherwise preserve them all.
          Remounting AppGate also resets its latched `ready`, so a local switch waits for
          the API to finish re-opening instead of firing reads at a closing database. */}
      <AppGate key={connectionId}>
        <div id="app-body">
          <nav id="activity-bar" aria-label={t("Main navigation")}>
            <div id="activity-top">
              {NAV_ITEMS
                .filter(({ remoteOnly }) => !remoteOnly || connection?.kind === 'remote')
                .map(({ id, Icon }) => (
                <button type="button"
                  key={id}
                  data-tour={`nav-${id}`}
                  className={`activity-btn${activeView === id ? " active" : ""}`}
                  onClick={() => setActiveView(id)}
                  title={labels[id]}
                  aria-label={labels[id]}
                  aria-current={activeView === id ? "page" : undefined}
                >
                  <Icon size={22} />
                </button>
              ))}
            </div>

            <div id="activity-bottom">
              <button type="button"
                data-tour="nav-config"
                className={`activity-btn${activeView === "config" ? " active" : ""}`}
                onClick={() => setActiveView("config")}
                title={labels.config}
                aria-label={labels.config}
                aria-current={activeView === "config" ? "page" : undefined}
              >
                <IconConfig size={22} />
              </button>
            </div>
          </nav>

          <main id="content-area">
            {ALL_VIEW_IDS.map(id => visitedRef.current.has(id) && (
              <div key={id} className={`view-slot${activeView === id ? ' view-slot--active' : ''}`}>
                <Suspense fallback={<div className="loading">{t("Loading…")}</div>}>
                  {renderView(id)}
                </Suspense>
              </div>
            ))}
          </main>
        </div>

        {/* Mounted inside AppGate so the shell and its nav exist before the
            spotlight tour tries to point at them. */}
        {tourOpen && <OnboardingTour onClose={handleCloseTour} onNavigate={setActiveView} />}
      </AppGate>

      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onNavigate={handleSearchNavigate}
        />
      )}

      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}

      {/* Outside AppGate on purpose. Switching vault remounts everything inside the gate;
          the manager is the thing that ORDERED the switch, so it has to outlive it long
          enough to report a failure instead of vanishing with the vault it was leaving. */}
      {vaultManagerOpen && (
        <VaultManager connection={connection} onClose={() => setVaultManagerOpen(false)} />
      )}
    </div>
    </SessionProvider>
  );
}
