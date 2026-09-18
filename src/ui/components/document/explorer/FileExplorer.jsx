/**
 * FileExplorer — the workspace tree in the sidebar: header actions, the root
 * listing of FolderNodes and FileNodes, the context menu, and the dialogs that
 * imports, tags, colours and clipping open. Role-gated controls are hidden, not
 * disabled. State lives in useExplorerTree.js and useImports.js.
 */

import { useState, useRef, useCallback } from "react";
import { moveItem } from "../../../api/documents";
import ContextMenu from "../../base/ContextMenu";
import ProgressDialog from "../../base/ProgressDialog";
import AnkiMappingModal from "../../deck/AnkiMappingModal";
import { useSession } from "../../../sessionContext.js";
import { useT } from "../../../translations/index";
import { canDropInto, destPathFor } from "./dragDrop.js";
import { contextMenuItems } from "./contextMenu.js";
import useExplorerTree from "./useExplorerTree";
import useImports from "../../../hooks/useImports";
import useDropTarget from "./useDropTarget";
import FolderNode from "./FolderNode";
import FileNode from "./FileNode";
import { InlineCreate } from "./TreeParts";
import {
  FolderSwatchModal,
  FolderTagsModal,
  ClipUrlModal,
} from "./ExplorerDialogs";
import "./FileExplorer.css";

const NewFolderIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.38a1.5 1.5 0 0 1 1.06.44L8 3.5H13.5A1.5 1.5 0 0 1 15 5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V3.5z" />
    <line x1="8" y1="7" x2="8" y2="11" />
    <line x1="6" y1="9" x2="10" y2="9" />
  </svg>
);
const NewFileIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9A1.5 1.5 0 0 0 14 13.5V6L9 1z" />
    <polyline points="9,1 9,6 14,6" />
    <line x1="8" y1="9" x2="8" y2="13" />
    <line x1="6" y1="11" x2="10" y2="11" />
  </svg>
);
const ImportIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <path d="M12 12L8 8L4 12" />
    <line x1="8" y1="8" x2="8" y2="15" />
    <rect x="2" y="2" width="12" height="4" rx="1" />
  </svg>
);
const ClipIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6.5 9.5a2.5 2.5 0 0 0 3.6.1l2.4-2.4a2.5 2.5 0 1 0-3.5-3.5l-1 1" />
    <path d="M9.5 6.5a2.5 2.5 0 0 0-3.6-.1L3.5 8.8a2.5 2.5 0 1 0 3.5 3.5l1-1" />
  </svg>
);

export default function FileExplorer({
  workspaceName = "Workspace",
  onSelect,
  onDoubleSelect,
  selectedPath,
  openPaths,
  toggleOpen,
  relocatePaths,
  onStudy,
}) {
  const { t } = useT();
  const { can } = useSession();
  const tree = useExplorerTree();
  const imports = useImports();
  const [ctxMenu, setCtxMenu] = useState(null);
  const [tagsTarget, setTagsTarget] = useState(null);
  const [swatchTarget, setSwatchTarget] = useState(null);
  const [clipTarget, setClipTarget] = useState(null);
  const fileInputRef = useRef(null);
  const importTargetRef = useRef("");

  const pickFilesFor = (folder) => {
    importTargetRef.current = folder;
    fileInputRef.current?.click();
  };
  const openClip = (path, refresh) =>
    setClipTarget({ path: path || "", refresh });
  const openCtxMenu = useCallback(
    (e, config) => setCtxMenu({ x: e.clientX, y: e.clientY, ...config }),
    [],
  );

  const drop = useDropTarget({
    onFiles: async (files) => {
      if (can("importDocuments")) await imports.importFiles(files, "");
    },
    onMove: async (srcPath, isFolder) => {
      if (!can("changeVaultShape") || !canDropInto(srcPath, "")) return;
      const dest = destPathFor(srcPath, "");
      try {
        await moveItem(srcPath, dest, isFolder);
        relocatePaths(srcPath, dest);
        tree.loadRoot();
      } catch (err) {
        console.error("Move to root failed", err);
      }
    },
  });

  const ctxItems = ctxMenu
    ? contextMenuItems(ctxMenu, can, t, {
        study: (scope) => onStudy?.(scope),
        editTags: setTagsTarget,
        setColor: (ctx) =>
          setSwatchTarget({
            path: ctx.folderPath,
            color: ctx.folderColor ?? "",
            refresh: ctx.refresh,
          }),
        importTo: pickFilesFor,
        clip: (ctx) =>
          openClip(
            ctx.isRoot ? "" : ctx.folderPath,
            ctx.isRoot ? tree.loadRoot : ctx.refresh,
          ),
      })
    : [];

  const shared = {
    onSelect,
    onDoubleSelect,
    selectedPath,
    relocatePaths,
    onCtxMenu: openCtxMenu,
    onRefresh: tree.loadRoot,
  };

  return (
    <div
      className={`fe-root${drop.dragOver ? " fe-drag-over" : ""}`}
      {...drop.props}
    >
      <div className="fe-header">
        <span className="fe-workspace-name">{workspaceName}</span>
        <div className="fe-header-actions">
          {can("createDocuments") && (
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => tree.setPendingNew("folder")}
              title={t("New folder")}
              aria-label={t("New folder")}
            >
              <NewFolderIcon />
            </button>
          )}
          {can("createDocuments") && (
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => tree.setPendingNew("file")}
              title={t("New file")}
              aria-label={t("New file")}
            >
              <NewFileIcon />
            </button>
          )}
          {can("importDocuments") && (
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => pickFilesFor("")}
              title={t("Import files / packages (.zip, .apkg, .md)")}
              aria-label={t("Import files")}
            >
              <ImportIcon />
            </button>
          )}
          {can("createDocuments") && (
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => openClip("", tree.loadRoot)}
              title={t("Clip from URL (web article or YouTube)")}
              aria-label={t("Clip from URL")}
            >
              <ClipIcon />
            </button>
          )}
        </div>
      </div>

      <div
        className="fe-tree"
        onContextMenu={(e) => {
          e.preventDefault();
          openCtxMenu(e, {
            isRoot: true,
            doNewFile: () => tree.setPendingNew("file"),
            doNewFolder: () => tree.setPendingNew("folder"),
          });
        }}
      >
        {tree.pendingNew && (
          <InlineCreate
            type={tree.pendingNew}
            onConfirm={tree.createAtRoot}
            onCancel={() => tree.setPendingNew(null)}
          />
        )}
        {tree.loading && <span className="fe-loading">{t("Loading…")}</span>}
        {!tree.loading && tree.error && (
          <span className="fe-empty fe-empty--error">
            {t("Couldn't load your files.")}
            <button
              type="button"
              className="btn btn--sm"
              onClick={tree.loadRoot}
            >
              {t("Try again")}
            </button>
          </span>
        )}
        {!tree.loading &&
          !tree.error &&
          !tree.pendingNew &&
          tree.items.length === 0 && (
            <span className="fe-empty">
              {t("No files yet — use the buttons above to get started.")}
            </span>
          )}
        {!tree.loading &&
          tree.items.map((item) =>
            item.type === "folder" ? (
              <FolderNode
                key={`${item.name}:${tree.treeVersion}`}
                name={item.name}
                path={item.name}
                flashcardCount={item.flashcardCount ?? 0}
                swatchColor={item.metadata?.swatchColor ?? ""}
                rollup={tree.progress?.folders?.[item.name] ?? null}
                openPaths={openPaths}
                toggleOpen={toggleOpen}
                onImportFiles={imports.importFiles}
                {...shared}
              />
            ) : (
              <FileNode
                key={item.name}
                name={item.name}
                path={item.name}
                globalHash={item.metadata?.globalHash}
                progress={
                  tree.progress?.documents?.[item.metadata?.globalHash] ?? null
                }
                flashcardCount={item.flashcardCount ?? 0}
                {...shared}
              />
            ),
          )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {imports.importing && (
        <ProgressDialog
          title={
            imports.importing.total === 1
              ? t("Importing file")
              : t("Importing file {index} of {total}", {
                  index: imports.importing.done + 1,
                  total: imports.importing.total,
                })
          }
          filename={imports.importing.filename}
          progress={
            ((imports.importing.done + imports.importing.pct / 100) /
              imports.importing.total) *
            100
          }
          processing={imports.importing.processing}
          statusText={
            imports.importing.processing
              ? t("Processing…")
              : t("Uploading… {percent}%", { percent: imports.importing.pct })
          }
        />
      )}

      {imports.ankiMapping && (
        <AnkiMappingModal
          report={imports.ankiMapping.report}
          filename={imports.ankiMapping.filename}
          importing={imports.ankiBusy}
          error={imports.ankiError}
          onCancel={imports.cancelMapping}
          onConfirm={imports.applyMapping}
        />
      )}

      {tagsTarget && (
        <FolderTagsModal
          path={tagsTarget}
          onClose={() => setTagsTarget(null)}
        />
      )}

      {swatchTarget && (
        <FolderSwatchModal
          path={swatchTarget.path}
          currentColor={swatchTarget.color}
          onClose={() => setSwatchTarget(null)}
          onSaved={() => {
            swatchTarget.refresh?.();
            setSwatchTarget(null);
          }}
        />
      )}

      {clipTarget && (
        <ClipUrlModal
          targetPath={clipTarget.path}
          onClose={() => setClipTarget(null)}
          onCreated={(newPath) => {
            clipTarget.refresh?.();
            setClipTarget(null);
            if (newPath) onDoubleSelect?.(newPath.replace(/\\/g, "/"));
          }}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        multiple
        accept=".zip,.apkg,.md,.txt,.pdf,.epub"
        onChange={(e) => {
          imports.importFiles(
            Array.from(e.target.files || []),
            importTargetRef.current || "",
          );
          e.target.value = "";
        }}
        aria-label={t("Upload files")}
      />
    </div>
  );
}
