import { lazy, Suspense, useState } from "react";

const DocumentsView = lazy(() => import("./views/Documents"));
const FlashcardsView = lazy(() => import("./views/Flashcards"));
const FlashcardTrainer = lazy(() => import("./views/Trainer"));
const GraphView = lazy(() => import("./views/GraphView"));
const ConfigView = lazy(() => import("./views/Config"));

const VIEWS = ["documents", "flashcards", "graph", "trainer", "config"];

export default function App() {
  const [activeView, setActiveView] = useState("documents");

  const renderView = () => {
    switch (activeView) {
      case "documents":
        return <DocumentsView />;
      case "flashcards":
        return <FlashcardsView />;
      case "graph":
        return <GraphView />;
      case "trainer":
        return <FlashcardTrainer />;
      case "config":
        return <ConfigView/>;
      default:
        return null;
    }
  };

  return (
    <div id="app">
      <nav id="sidebar">
        {VIEWS.map((view) => (
          <button
            key={view}
            className={activeView === view ? "active" : ""}
            onClick={() => setActiveView(view)}
          >
            {view}
          </button>
        ))}
      </nav>
      <main id="content">
        <Suspense fallback={<div className="loading">Loading...</div>}>
          {renderView()}
        </Suspense>
      </main>
    </div>
  );
}
