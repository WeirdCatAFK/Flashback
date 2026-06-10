import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import "./App.css";

import IconDocuments from "./components/icons/IconDocuments";
import IconFlashcards from "./components/icons/IconFlashcards";
import IconDecks from "./components/icons/IconDecks";
import IconGraph from "./components/icons/IconGraph";
import IconTrainer from "./components/icons/IconTrainer";
import IconConfig from "./components/icons/IconConfig";
import IconSeal from "./components/icons/IconSeal";
import { THEMES } from "./themes";
import { loadCustomThemes, injectCustomThemeCSS } from "./customThemes";
import AppGate from "./components/AppGate";
import SearchModal from "./components/search/SearchModal";

const ALL_VIEW_IDS = ['documents', 'flashcards', 'decks', 'graph', 'trainer', 'seal', 'config'];

const DocumentsView  = lazy(() => import("./views/Documents"));
const FlashcardsView = lazy(() => import("./views/Flashcards"));
const DecksView      = lazy(() => import("./views/Decks"));
const GraphView      = lazy(() => import("./views/GraphView"));
const TrainerView    = lazy(() => import("./views/Trainer"));
const ConfigView     = lazy(() => import("./views/Config"));
const SealView       = lazy(() => import("./views/Seal"));

const NAV_ITEMS = [
  { id: "documents",  Icon: IconDocuments,  label: "Documents" },
  { id: "flashcards", Icon: IconFlashcards, label: "Flashcards" },
  { id: "decks",      Icon: IconDecks,      label: "Decks" },
  { id: "graph",      Icon: IconGraph,      label: "Graph" },
  { id: "trainer",    Icon: IconTrainer,    label: "Trainer" },
  { id: "seal",       Icon: IconSeal,       label: "Seal" },
];

export default function App() {
  const [activeView, setActiveView] = useState("documents");

  const [theme, setTheme] = useState(
    () => localStorage.getItem("fb-theme") ?? "light-workbench"
  );
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

  const [pendingSource, setPendingSource] = useState(null); // { path, highlightId }
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
      case "decks":      return <DecksView onStudyDeck={handleStartStudy} />;
      case "graph":      return <GraphView isActive={activeView === 'graph'} />;
      case "trainer":    return <TrainerView isActive={activeView === 'trainer'} studySession={studySession} onOpenSource={handleOpenDocumentSource} />;
      case "seal":       return <SealView />;
      case "config":     return (
        <ConfigView
          theme={theme}
          onThemeChange={setTheme}
          allThemes={allThemes}
          customThemes={customThemes}
          onCustomThemesChange={setCustomThemes}
        />
      );
      default: return null;
    }
  }

  return (
    <div id="app-shell">
      <div id="title-bar">
        <span id="app-title">Flashback</span>
        <button
          type="button"
          id="search-btn"
          title="Search (Ctrl+K)"
          aria-label="Search"
          onClick={() => setSearchOpen(true)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span>Search</span>
          <kbd>Ctrl+K</kbd>
        </button>
        <div id="window-controls">
          <button type="button" className="wc-btn wc-minimize" title="Minimize" aria-label="Minimize"
            onClick={() => window.flashback?.windowMinimize()}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button type="button" className="wc-btn wc-maximize" title="Maximize" aria-label="Maximize"
            onClick={() => window.flashback?.windowMaximize()}>
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><rect x=".5" y=".5" width="8" height="8" stroke="currentColor"/></svg>
          </button>
          <button type="button" className="wc-btn wc-close" title="Close" aria-label="Close"
            onClick={() => window.flashback?.windowClose()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>

      <AppGate>
        <div id="app-body">
          <nav id="activity-bar" aria-label="Main navigation">
            <div id="activity-top">
              {NAV_ITEMS.map(({ id, Icon, label }) => (
                <button type="button"
                  key={id}
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
                className="activity-btn"
                onClick={() => setSearchOpen(true)}
                title="Search (Ctrl+K)"
                aria-label="Search"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </button>
              <button type="button"
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
      </AppGate>

      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onNavigate={handleSearchNavigate}
        />
      )}
    </div>
  );
}
