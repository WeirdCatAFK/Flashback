/**
 * DocumentEditor — the tab bar, the reading strip, the active document's head and
 * renderer in one scroller, the floating selection toolbar, the finder (Ctrl+F) and
 * the card editor, wired together. Renderers are chosen from
 * renderers/registry.js and their capability flags read as data; the state lives
 * in useDocumentEditor.js, useSelectionToolbar.js and useHighlightActions.js.
 * ReadingBar is imported statically so it never lands in a lazy chunk, and sits
 * under the tab bar for every format.
 */

import { useState, useRef, useEffect, useMemo, Suspense } from "react";
import EditorTabBar from "./EditorTabBar";
import SelectionToolbar from "../highlight/SelectionToolbar";
import DocumentHead from "./DocumentHead";
import MarginCards from "./margin/MarginCards";
import Finder from "./Finder";
import DocumentCardBench from "./DocumentCardBench";
import CardBench from "../flashcard/CardBench";
import useCardBench from "../flashcard/useCardBench";
import { rendererFor } from "./renderers/registry";
import ReadingBar from "./ReadingBar";
import { useReadProgress } from "./useReadProgress";
import { useT } from "../../translations/index";
import { useSession } from "../../sessionContext.js";
import { barProgressFor } from "./tabsState.js";
import useDocumentEditor from "./useDocumentEditor";
import useSelectionToolbar from "./useSelectionToolbar";
import useHighlightActions from "./useHighlightActions";
import "./DocumentEditor.css";

/** How long a jump waits for the smooth scroll before the passage glows, and how long it stays lit. */
const FLASH_DELAY = 320;
const FLASH_HOLD = 1200;

export default function DocumentEditor({
  isActive = true,
  treeToggle = null,
  openTabs,
  activeTab,
  previewTab,
  onTabChange,
  onTabClose,
  onTabDoubleClick,
  pendingHighlight,
  onHighlightConsumed,
  onNavigate,
  relocation,
}) {
  const { t } = useT();
  const { can } = useSession();
  const rendererRef = useRef(null);
  const saveRef = useRef(null);
  const highlightRef = useRef(null);
  const progressRef = useRef(null);

  const progress = useReadProgress(activeTab);
  const [shownProgress, setShownProgress] = useState(null);
  useEffect(() => {
    setShownProgress(progress.initialProgress ?? null);
  }, [progress.initialProgress]);
  const barProgress = useMemo(
    () => barProgressFor(shownProgress, progress.live),
    [shownProgress, progress.live],
  );

  const doc = useDocumentEditor({ activeTab, openTabs, relocation });
  const sel = useSelectionToolbar({ isActive, rendererRef });
  const actions = useHighlightActions({
    activeTab,
    highlights: doc.highlights,
    flashcards: doc.flashcards,
    highlightRef,
    saveRef,
    selection: sel.selection,
    clearSelection: sel.clear,
    refreshSidecar: doc.refreshSidecar,
    pendingHighlight,
    onHighlightConsumed,
  });
  const [finderOpen, setFinderOpen] = useState(false);
  const [finderLinked, setFinderLinked] = useState(null);
  const [flashHl, setFlashHl] = useState(null);
  const flashTimers = useRef([]);
  useEffect(() => () => flashTimers.current.forEach(clearTimeout), []);
  const [toolsEl, setToolsEl] = useState(null);
  const [marginShown, setMarginShown] = useState(false);
  const bench = useCardBench({
    announce: false,
    onChanged: () => activeTab && doc.refreshSidecar(activeTab),
  });

  const [finderFor, setFinderFor] = useState(activeTab);
  if (finderFor !== activeTab) {
    setFinderFor(activeTab);
    setFinderOpen(false);
  }

  useEffect(() => {
    if (!isActive) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFinderOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  const activeRenderer = rendererFor(activeTab);
  const writesBody = activeRenderer.editable;
  const mayWriteBody = !writesBody || can("editDocumentBody");
  const editable = writesBody && mayWriteBody;
  const supportsHighlight = activeRenderer.supportsHighlight && mayWriteBody;
  const isActiveDirty = doc.dirtyPaths.has(activeTab);
  const Renderer = activeRenderer.load;

  const head = activeTab ? (
    <DocumentHead
      path={activeTab}
      cover={doc.cover}
      title={doc.sourceTitle}
      tags={doc.tags}
      excludedTags={doc.excludedTags}
      mayAnnotate={can("annotate")}
      onTagsChange={doc.handleTagsChange}
      onCoverChange={doc.setCover}
    />
  ) : null;

  /**
   * The card margin. Mounted here in the shared scroller, or — for a renderer that
   * scrolls itself (`hostsHead`) — by the renderer inside its own scroller, with
   * its own `measure`.
   */
  /** Jump to a passage and let it glow once it has scrolled into view. */
  const jumpAndFlash = (id) => {
    actions.jumpToHighlight(id);
    flashTimers.current.forEach(clearTimeout);
    flashTimers.current = [
      setTimeout(() => setFlashHl(id), FLASH_DELAY),
      setTimeout(() => setFlashHl(null), FLASH_DELAY + FLASH_HOLD),
    ];
  };

  /** Where each inline mark sits on the page, top to bottom, for the finder's order. */
  const domOrder = () => {
    const ids = [];
    rendererRef.current?.querySelectorAll("[data-hl]").forEach((el) => {
      const id = el.getAttribute("data-hl");
      if (!el.closest(".doc-margin") && !ids.includes(id)) ids.push(id);
    });
    return ids;
  };

  const renderMargin = ({ scrollerRef, measure, relayoutKey = "" }) => (
    <MarginCards
      scrollerRef={scrollerRef}
      measure={measure}
      highlights={doc.highlights}
      flashcards={doc.flashcards}
      relayoutKey={`${doc.dataVersion}:${relayoutKey}`}
      canEdit={can("editCards")}
      onEditCard={bench.openEdit}
      onShownChange={setMarginShown}
      outsideLinked={finderLinked ?? flashHl}
    />
  );

  const readingBar = (
    <ReadingBar
      toolsRef={setToolsEl}
      progress={barProgress}
      tracks={activeRenderer.tracksProgress}
      resumed={!!progress.resumeAt}
      onFind={() => setFinderOpen((o) => !o)}
      findOpen={finderOpen}
      onGoToStart={() => {
        progressRef.current?.goToStart?.();
        progress.dismissResume();
      }}
      onDismissResume={progress.dismissResume}
      readPosition={() => progressRef.current?.currentPosition?.() ?? null}
      onSetHere={async (body) =>
        setShownProgress(await progress.setManualProgress(body))
      }
      onMarkFinished={async (body) =>
        setShownProgress(await progress.setManualProgress(body))
      }
      onClear={async () => {
        await progress.clearProgress();
        setShownProgress(null);
      }}
    />
  );

  if (!activeTab || openTabs.length === 0) {
    return (
      <div className="doc-editor">
        <div className="tab-bar">{treeToggle}</div>
        <div className="doc-editor--empty">
          <p>{t("Select a file to open it.")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-editor">
      <EditorTabBar
        leading={treeToggle}
        tabs={openTabs}
        activeTab={activeTab}
        previewTab={previewTab}
        dirtyPaths={doc.dirtyPaths}
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabDoubleClick={onTabDoubleClick}
        onSave={editable ? () => saveRef.current?.() : undefined}
        canSave={isActiveDirty}
        isDirty={isActiveDirty}
      />

      <div className="doc-editor-body">
        <div className="doc-editor-content">
          {readingBar}
          <div
            key={activeTab}
            className={`doc-editor-renderer${activeRenderer.hostsHead ? " doc-editor-renderer--hosted" : ""}${activeRenderer.marginCards && marginShown ? " has-margin" : ""}`}
            ref={rendererRef}
            onMouseUp={sel.onMouseUp}
          >
            {!activeRenderer.hostsHead && head}
            <Suspense
              fallback={
                <div className="doc-editor-loading">{t("Loading…")}</div>
              }
            >
              <Renderer
                key={`${activeTab}:${doc.dataVersion}`}
                path={activeTab}
                readOnly={!mayWriteBody}
                onDirtyChange={doc.handleDirtyChange}
                saveRef={saveRef}
                highlightRef={highlightRef}
                onHighlightsChange={doc.handleHighlightsChange}
                onSidecarRefresh={doc.handleSidecarRefresh}
                draftContent={doc.drafts.get(activeTab)}
                onDraftChange={doc.handleDraftChange}
                onNavigate={onNavigate}
                onExternalSelection={sel.onExternalSelection}
                onHighlightPick={sel.pick}
                onImagePick={actions.pickImage}
                initialProgress={progress.initialProgress}
                onProgress={progress.reportProgress}
                progressRef={progressRef}
                toolsTarget={toolsEl}
                head={activeRenderer.hostsHead ? head : undefined}
                renderMargin={activeRenderer.hostsHead && activeRenderer.marginCards ? renderMargin : undefined}
                marginShown={marginShown}
              />
            </Suspense>
            {activeRenderer.marginCards && !activeRenderer.hostsHead && renderMargin({ scrollerRef: rendererRef })}
          </div>

          {isActive && sel.picked && !sel.selection && (
            <SelectionToolbar
              rect={sel.picked.rect}
              currentColor={doc.highlights.find((h) => h.id === sel.picked.id)?.color ?? null}
              onMakeCard={() => { actions.cardFromHighlight(sel.picked.id); sel.clear(); }}
              onHighlight={supportsHighlight ? (color) => actions.recolor(sel.picked.id, color) : undefined}
              onUnhighlight={supportsHighlight ? () => actions.deleteHighlight(sel.picked.id, "toolbar") : undefined}
              removal={actions.pendingRemoval?.from === "toolbar" ? actions.pendingRemoval : null}
              onResolveRemoval={actions.resolveRemoval}
              onCancelRemoval={() => { actions.cancelRemoval(); sel.clear(); }}
              onClear={sel.clear}
            />
          )}

          {isActive && sel.selection && sel.rect && (
            <SelectionToolbar
              rect={sel.rect}
              onMakeCard={actions.makeCard}
              onHighlight={supportsHighlight ? actions.highlight : undefined}
              onUnhighlight={
                supportsHighlight ? actions.unhighlight : undefined
              }
              removal={actions.pendingRemoval?.from === "toolbar" ? actions.pendingRemoval : null}
              onResolveRemoval={actions.resolveRemoval}
              onCancelRemoval={actions.cancelRemoval}
              onClear={sel.clear}
            />
          )}

          {finderOpen && (
            <Finder
              highlights={doc.highlights}
              flashcards={doc.flashcards}
              canEditCards={can("editCards")}
              canAnnotate={supportsHighlight}
              onClose={() => { setFinderOpen(false); setFinderLinked(null); actions.cancelRemoval(); }}
              onJump={jumpAndFlash}
              linkedId={finderLinked}
              onLink={setFinderLinked}
              domOrder={domOrder}
              onAddCard={(id) => { setFinderOpen(false); actions.cardFromHighlight(id); }}
              onEditCard={(hash) => { setFinderOpen(false); bench.openEdit(hash); }}
              onRemove={actions.deleteHighlight}
              removal={actions.pendingRemoval}
              onResolveRemoval={actions.resolveRemoval}
              onCancelRemoval={actions.cancelRemoval}
            />
          )}

          {actions.cardDraft && (
            <DocumentCardBench
              key={`${activeTab}:${actions.cardDraft.highlightId ?? ""}`}
              path={activeTab}
              draft={actions.cardDraft}
              onClose={actions.closeCardDraft}
              onSaved={actions.cardSaved}
            />
          )}
          {bench.benchProps && <CardBench key={bench.benchKey} {...bench.benchProps} />}
        </div>
      </div>
    </div>
  );
}
