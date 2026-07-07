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
import { THEMES } from "./themes";
import { loadCustomThemes, injectCustomThemeCSS } from "./customThemes";
import AppGate from "./components/AppGate";
import SearchModal from "./components/search/SearchModal";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import OnboardingTour from "./components/onboarding/OnboardingTour";
import TitleBar from "./components/TitleBar";
import { relocatePath } from "./utils/relocatePath";

const ALL_VIEW_IDS = ['documents', 'flashcards', 'decks', 'graph', 'trainer', 'stats', 'seal', 'manage', 'config'];

const DocumentsView  = lazy(() => import("./views/Documents"));
const FlashcardsView = lazy(() => import("./views/Flashcards"));
const DecksView      = lazy(() => import("./views/Decks"));
const GraphView      = lazy(() => import("./views/GraphView"));
const TrainerView    = lazy(() => import("./views/Trainer"));
const ConfigView     = lazy(() => import("./views/Config"));
const SealView       = lazy(() => import("./views/Seal"));
const ManageView     = lazy(() => import("./views/Manage"));
const StatsView      = lazy(() => import("./views/Stats"));

const NAV_ITEMS = [
  { id: "documents",  Icon: IconDocuments,  label: "Documents" },
  { id: "flashcards", Icon: IconFlashcards, label: "Flashcards" },
  { id: "decks",      Icon: IconDecks,      label: "Decks" },
  { id: "graph",      Icon: IconGraph,      label: "Graph" },
  { id: "trainer",    Icon: IconTrainer,    label: "Trainer" },
  { id: "stats",      Icon: IconStats,      label: "Statistics" },
  { id: "seal",       Icon: IconSeal,       label: "Seal" },
  { id: "manage",     Icon: IconManage,     label: "Manage" },
];

export default function App() {
  const [activeView, setActiveView] = useState("documents");

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("fb-theme");
    if (saved) return saved;
    // No explicit choice yet — follow the OS light/dark preference.
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark-workbench" : "light-workbench";
  });
  const [customThemes, setCustomThemes] = useState(() => loadCustomThemes());
  const allThemes = useMemo(() => [...THEMES, ...customThemes.map(t => t.name)], [customThemes]);

  // Inject custom theme CSS on startup and whenever custom themes change
  useEffect(() => { injectCustomThemeCSS(customThemes); }, [customThemes]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fb-theme", theme);
  }, [theme]);

  const [selectedPath, setSelectedPath] = useState(null);
  const [openPaths, setOpenPaths] = useState(() => new Set());

  const [studySession, setStudySession] = useState(null);
  const handleStartStudy = useCallback((session) => {
    setStudySession(session);
    setActiveView('trainer');
  }, []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
      case "config":     return (
        <ConfigView
          theme={theme}
          onThemeChange={setTheme}
          allThemes={allThemes}
          customThemes={customThemes}
          onCustomThemesChange={setCustomThemes}
          onReplayTour={() => setTourOpen(true)}
        />
      );
      default: return null;
    }
  }

  return (
    <div id="app-shell">
      <TitleBar onSearch={() => setSearchOpen(true)} />

      <AppGate>
        <div id="app-body">
          <nav id="activity-bar" aria-label="Main navigation">
            <div id="activity-top">
              {NAV_ITEMS.map(({ id, Icon, label }) => (
                <button type="button"
                  key={id}
                  data-tour={`nav-${id}`}
                  className={`activity-btn${activeView === id ? " active" : ""}`}
                  onClick={() => setActiveView(id)}
                  title={label}
                  aria-label={label}
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
                title="Config"
                aria-label="Config"
                aria-current={activeView === "config" ? "page" : undefined}
              >
                <IconConfig size={22} />
              </button>
            </div>
          </nav>

          <main id="content-area">
            {ALL_VIEW_IDS.map(id => visitedRef.current.has(id) && (
              <div key={id} className={`view-slot${activeView === id ? ' view-slot--active' : ''}`}>
                <Suspense fallback={<div className="loading">Loading…</div>}>
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
    </div>
  );
}
