import React, { lazy, Suspense, useState } from "react";
import './App.css';

const DocumentView = lazy(() => import("./views/Documents"));
const FlashcardsView = lazy(() => import("./views/Flashcards")); 
const GraphView = lazy(() => import("./views/Graph"));

const App = () => {
  const [activeView, setActiveView] = useState("documents");

  const renderView = () => {
    switch (activeView) {
      case "documents":
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <DocumentView />
          </Suspense>
        );
      case "flashcards":
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <FlashcardsView />
          </Suspense>
        );
      case "graph":
        return (
          <Suspense fallback={<div>Loading...</div>}>
            <GraphView />
          </Suspense>
        );
      default:
        return <div>Select a view from the sidebar</div>;
    }
  };

  return (
    <div id="main-container">
      <div className="toolbar">
        <button className="btn-toolbar">File</button>
        <button className="btn-toolbar">Edit</button>
        <button className="btn-toolbar">View</button>
        <button className="btn-toolbar">Annotate</button>
      </div>
      <div className="app-container">
        <div className="sidebar">
          <button
            onClick={() => setActiveView("documents")}
            className={activeView === "documents" ? "active" : ""}
            style={{
              backgroundImage: "url('./assets/icons/Document_ico.png')",
            }}
          ></button>
          <button
            onClick={() => setActiveView("flashcards")}
            className={activeView === "flashcards" ? "active" : ""}
            style={{
              backgroundImage: "url('./assets/icons/Flashcards_ico.png')",
            }}
          ></button>
          <button
            onClick={() => setActiveView("graph")}
            className={activeView === "graph" ? "active" : ""}
            style={{ backgroundImage: "url('./assets/icons/Graph_ico.png')" }}
          ></button>
        </div>
        <div className="main-content">{renderView()}</div>
      </div>
    </div>
  );
};

export default App;