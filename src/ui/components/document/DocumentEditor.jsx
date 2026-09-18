/**
 * DocumentEditor — the tab bar, the active document's renderer, the floating
 * selection toolbar and the inspector, wired together. Renderers are chosen from
 * renderers/registry.js and their capability flags read as data; the state lives
 * in useDocumentEditor.js, useSelectionToolbar.js and useHighlightActions.js.
 * ReadingBar is imported statically so it never lands in a lazy chunk;
 * `ownsReadingBar` only decides where it renders.
 */

import { useState, useRef, useEffect, useMemo, Suspense } from "react";
import EditorTabBar from "./EditorTabBar";
import SelectionToolbar from "../highlight/SelectionToolbar";
import Inspector from "./inspector/Inspector";
import HighlightRemoveDialog from "../highlight/HighlightRemoveDialog";
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

export default function DocumentEditor({
  isActive = true,
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
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const activeRenderer = rendererFor(activeTab);
  const writesBody = activeRenderer.editable;
  const mayWriteBody = !writesBody || can("editDocumentBody");
  const editable = writesBody && mayWriteBody;
  const supportsHighlight = activeRenderer.supportsHighlight && mayWriteBody;
  const isActiveDirty = doc.dirtyPaths.has(activeTab);
  const Renderer = activeRenderer.load;

  const readingBar = activeRenderer.tracksProgress ? (
    <ReadingBar
      progress={barProgress}
      resumed={!!progress.resumeAt}
      variant={activeRenderer.ownsReadingBar ? "inline" : "strip"}
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
  ) : null;

  if (!activeTab || openTabs.length === 0) {
    return (
      <div className="doc-editor doc-editor--empty">
        <p>{t("Select a file to open it.")}</p>
      </div>
    );
  }

  return (
    <div className="doc-editor">
      <EditorTabBar
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
          {!activeRenderer.ownsReadingBar && readingBar}
          <div
            className="doc-editor-renderer"
            ref={rendererRef}
            onMouseUp={sel.onMouseUp}
          >
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
                onImagePick={actions.pickImage}
                initialProgress={progress.initialProgress}
                onProgress={progress.reportProgress}
                progressRef={progressRef}
                readingBar={
                  activeRenderer.ownsReadingBar ? readingBar : undefined
                }
              />
            </Suspense>
          </div>

          {isActive && sel.selection && sel.rect && (
            <SelectionToolbar
              rect={sel.rect}
              onMakeCard={actions.makeCard}
              onHighlight={supportsHighlight ? actions.highlight : undefined}
              onUnhighlight={
                supportsHighlight ? actions.unhighlight : undefined
              }
              onClear={sel.clear}
            />
          )}
        </div>

        <Inspector
          path={activeTab}
          activeTab={actions.inspectorTab}
          onTabChange={actions.changeInspectorTab}
          cardDraft={actions.cardDraft}
          highlights={doc.highlights}
          flashcards={doc.flashcards}
          tags={doc.tags}
          excludedTags={doc.excludedTags}
          onTagsChange={doc.handleTagsChange}
          onJumpToHighlight={actions.jumpToHighlight}
          onHighlightCardRequest={actions.cardFromHighlight}
          onHighlightDeleteRequest={actions.deleteHighlight}
          onCardSaved={actions.cardSaved}
          onSelectionClear={sel.clear}
          open={inspectorOpen}
          onToggle={() => setInspectorOpen((o) => !o)}
        />
      </div>

      {actions.pendingRemoval && (
        <HighlightRemoveDialog
          cardCount={actions.pendingRemoval.cardCount}
          onCancel={actions.cancelRemoval}
          onKeepCards={() => actions.resolveRemoval(false)}
          onDeleteCards={() => actions.resolveRemoval(true)}
        />
      )}
    </div>
  );
}
