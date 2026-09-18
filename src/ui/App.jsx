/**
 * App — the shell: title bar, activity bar and the keep-alive view slots, plus
 * the app-level state that crosses views (theme, zoom, the study hand-over to
 * the Trainer, whose progress Stats and Graph show, the search palette, dialogs
 * and the tour). Views are lazy per folder under views/.
 */

import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
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
import AppGate from "./components/shell/AppGate";
import SearchModal from "./components/shell/SearchModal";
import ShortcutsOverlay from "./components/shell/ShortcutsOverlay";
import OnboardingTour from "./components/shell/OnboardingTour";
import TitleBar from "./components/shell/TitleBar";
import VaultManager from "./components/vault/VaultManager";
import { relocatePath } from "./utils/relocatePath";
import { notifyUiZoomChanged } from "./utils/uiZoom";
import { invalidateData } from "./utils/dataBus";
import { useT } from "./translations/index";
import { diaryLabels, isSharedVault } from "./diaryLabels.js";
import useConnection from "./hooks/useConnection.js";
import { SessionProvider } from "./session.jsx";
import { getPref, setPref, setActiveVaultScope } from "./prefs.js";

const ALL_VIEW_IDS = [
  "documents",
  "flashcards",
  "decks",
  "graph",
  "trainer",
  "stats",
  "diary",
  "seal",
  "manage",
  "server",
  "config",
];

const DocumentsView = lazy(() => import("./views/documents/Documents"));
const FlashcardsView = lazy(() => import("./views/flashcards/Flashcards"));
const DecksView = lazy(() => import("./views/decks/Decks"));
const GraphView = lazy(() => import("./views/graph/GraphView"));
const TrainerView = lazy(() => import("./views/trainer/Trainer"));
const ConfigView = lazy(() => import("./views/config/Config"));
const SealView = lazy(() => import("./views/seal/Seal"));
const ManageView = lazy(() => import("./views/manage/Manage"));
const StatsView = lazy(() => import("./views/stats/Stats"));
const DiaryView = lazy(() => import("./views/diary/Diary"));
const ServerView = lazy(() => import("./views/server/Server"));

const NAV_ITEMS = [
  { id: "documents", Icon: IconDocuments },
  { id: "flashcards", Icon: IconFlashcards },
  { id: "decks", Icon: IconDecks },
  { id: "graph", Icon: IconGraph },
  { id: "trainer", Icon: IconTrainer },
  { id: "stats", Icon: IconStats },
  { id: "diary", Icon: IconDiary },
  { id: "seal", Icon: IconSeal },
  { id: "manage", Icon: IconManage },
  { id: "server", Icon: IconServer, remoteOnly: true },
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
 *
 * Takes `shared` for the same reason `diaryLabels()` does: the study record is a private
 * diary on a local vault and a shared log on a server, and the tab has to say which.
 */
function navLabels(t, shared) {
  return {
    documents: t("Documents"),
    flashcards: t("Flashcards"),
    decks: t("Decks"),
    graph: t("Graph"),
    trainer: t("Trainer"),
    stats: t("Statistics"),
    diary: diaryLabels(t, shared).title,
    seal: t("Seal"),
    manage: t("Manage"),
    server: t("Server"),
    config: t("Config"),
  };
}

export default function App() {
  const { t } = useT();
  const [activeView, setActiveView] = useState("documents");
  const [progressAccount, setProgressAccount] = useState(null);

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("fb-theme");
    if (saved) return saved;
    const prefersDark = window.matchMedia?.(
      "(prefers-color-scheme: dark)",
    ).matches;
    return prefersDark ? "dark-workbench" : "light-workbench";
  });
  const [customThemes, setCustomThemes] = useState(() => loadCustomThemes());
  const allThemes = useMemo(
    () => [...THEMES, ...customThemes.map((ct) => ct.name)],
    [customThemes],
  );

  useEffect(() => {
    injectCustomThemeCSS(customThemes);
  }, [customThemes]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fb-theme", theme);
  }, [theme]);

  const { connection, connectionId } = useConnection();
  const shared = isSharedVault(connection);
  const labels = navLabels(t, shared);

  const [selectedPath, setSelectedPath] = useState(null);
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

  useEffect(() => {
    if (!connection) return;
    setActiveVaultScope(connection.id ?? null);
    setActiveView((current) => {
      const item = NAV_ITEMS.find((n) => n.id === current);
      return item?.remoteOnly && connection.kind !== "remote"
        ? "documents"
        : current;
    });
    setSelectedPath(null);
    setPendingSource(null);
    setPendingDeck(null);
    setStudySession(null);
    setProgressAccount(null);
    try {
      const saved = JSON.parse(getPref("fb-open-folders") ?? "[]");
      setOpenPaths(new Set(Array.isArray(saved) ? saved : []));
    } catch {
      setOpenPaths(new Set());
    }
    invalidateData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, connection?.url]);

  const [studySession, setStudySession] = useState(null);
  const handleStartStudy = useCallback((session) => {
    setStudySession(session);
    setActiveView("trainer");
  }, []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [vaultManagerOpen, setVaultManagerOpen] = useState(false);

  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (!localStorage.getItem("fb-onboarding-seen")) setTourOpen(true);
  }, []);
  const handleCloseTour = useCallback(() => {
    localStorage.setItem("fb-onboarding-seen", "1");
    setTourOpen(false);
  }, []);

  const [pendingSource, setPendingSource] = useState(null);
  const [pendingDeck, setPendingDeck] = useState(null);
  const handleOpenDocumentSource = useCallback((documentPath, highlightId) => {
    setActiveView("documents");
    setPendingSource({ path: documentPath, highlightId: highlightId ?? null });
  }, []);

  const toggleOpen = useCallback((folderPath) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const relocatePaths = useCallback((oldPrefix, newPrefix) => {
    setOpenPaths((prev) => {
      const affected = [...prev].filter(
        (p) => p === oldPrefix || p.startsWith(oldPrefix + "/"),
      );
      if (affected.length === 0) return prev;
      const next = new Set(prev);
      for (const p of affected) {
        next.delete(p);
        next.add(newPrefix + p.slice(oldPrefix.length));
      }
      return next;
    });
    setSelectedPath((prev) => relocatePath(prev, oldPrefix, newPrefix));
  }, []);

  const [zoom, setZoom] = useState(() =>
    parseFloat(localStorage.getItem("fb-zoom") ?? "1"),
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-zoom", zoom);
    localStorage.setItem("fb-zoom", zoom);
    notifyUiZoomChanged();
  }, [zoom]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "?") {
        const tag = document.activeElement?.tagName.toLowerCase();
        if (
          !["input", "textarea", "select"].includes(tag) &&
          !document.activeElement?.isContentEditable
        ) {
          e.preventDefault();
          setShortcutsOpen((o) => !o);
          return;
        }
      }
      if (!e.ctrlKey) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => Math.min(2, parseFloat((z + 0.1).toFixed(1))));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(0.5, parseFloat((z - 0.1).toFixed(1))));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleViewProgress = useCallback((account) => {
    setProgressAccount(
      account
        ? { id: account.id, name: account.name, role: account.role }
        : null,
    );
    setActiveView("stats");
  }, []);

  const handleSearchNavigate = useCallback(
    ({ type, payload }) => {
      switch (type) {
        case "document":
          setActiveView("documents");
          setPendingSource({ path: payload.path, highlightId: null });
          break;
        case "folder":
          setActiveView("documents");
          setOpenPaths((prev) => {
            const n = new Set(prev);
            n.add(payload.path);
            return n;
          });
          setSelectedPath(payload.path);
          break;
        case "flashcard":
          if (payload.documentPath) {
            setActiveView("documents");
            setPendingSource({ path: payload.documentPath, highlightId: null });
          } else {
            setActiveView("flashcards");
          }
          break;
        case "tag":
          handleStartStudy({ tags: [payload.name] });
          break;
        case "deck":
          setActiveView("decks");
          setPendingDeck(payload.hash);
          break;
        default:
          break;
      }
    },
    [handleStartStudy],
  );

  const visitedRef = useRef(null);
  if (visitedRef.current === null) visitedRef.current = new Set();
  visitedRef.current.add(activeView);

  function renderView(view) {
    switch (view) {
      case "documents":
        return (
          <DocumentsView
            isActive={activeView === "documents"}
            openPaths={openPaths}
            toggleOpen={toggleOpen}
            relocatePaths={relocatePaths}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            onStudy={handleStartStudy}
            openSource={pendingSource}
            onOpenSourceConsumed={() => setPendingSource(null)}
          />
        );
      case "flashcards":
        return <FlashcardsView />;
      case "decks":
        return (
          <DecksView
            onStudyDeck={handleStartStudy}
            openDeck={pendingDeck}
            onOpenDeckConsumed={() => setPendingDeck(null)}
          />
        );
      case "graph":
        return (
          <GraphView
            isActive={activeView === "graph"}
            onNavigate={handleSearchNavigate}
            viewingAccount={progressAccount}
            onViewingAccountChange={setProgressAccount}
          />
        );
      case "trainer":
        return (
          <TrainerView
            isActive={activeView === "trainer"}
            studySession={studySession}
            onOpenSource={handleOpenDocumentSource}
          />
        );
      case "seal":
        return <SealView isActive={activeView === "seal"} />;
      case "manage":
        return <ManageView isActive={activeView === "manage"} />;
      case "stats":
        return (
          <StatsView
            isActive={activeView === "stats"}
            viewingAccount={progressAccount}
            onViewingAccountChange={setProgressAccount}
          />
        );
      case "diary":
        return (
          <DiaryView
            isActive={activeView === "diary"}
            connection={connection}
          />
        );
      case "server":
        return (
          <ServerView
            connection={connection}
            onViewProgress={handleViewProgress}
          />
        );
      case "config":
        return (
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
      default:
        return null;
    }
  }

  return (
    <SessionProvider
      key={`session-${connectionId}`}
      connectionId={connectionId}
    >
      <div id="app-shell">
        <TitleBar
          onSearch={() => setSearchOpen(true)}
          connection={connection}
          onManageVaults={() => setVaultManagerOpen(true)}
        />

        <AppGate key={connectionId}>
          <div id="app-body">
            <nav id="activity-bar" aria-label={t("Main navigation")}>
              <div id="activity-top">
                {NAV_ITEMS.filter(
                  ({ remoteOnly }) =>
                    !remoteOnly || connection?.kind === "remote",
                ).map(({ id, Icon }) => (
                  <button
                    type="button"
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
                <button
                  type="button"
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
              {ALL_VIEW_IDS.map(
                (id) =>
                  visitedRef.current.has(id) && (
                    <div
                      key={id}
                      className={`view-slot${activeView === id ? " view-slot--active" : ""}`}
                    >
                      <Suspense
                        fallback={
                          <div className="loading">{t("Loading…")}</div>
                        }
                      >
                        {renderView(id)}
                      </Suspense>
                    </div>
                  ),
              )}
            </main>
          </div>

          {tourOpen && (
            <OnboardingTour
              onClose={handleCloseTour}
              onNavigate={setActiveView}
            />
          )}
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

        {vaultManagerOpen && (
          <VaultManager
            connection={connection}
            onClose={() => setVaultManagerOpen(false)}
          />
        )}
      </div>
    </SessionProvider>
  );
}
