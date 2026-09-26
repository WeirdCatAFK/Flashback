/**
 * FileExplorer — the workspace tree in the sidebar: the "+" menu, the root
 * listing of FolderNodes and FileNodes, the context menu, and the dialogs that
 * imports, tags, colours and clipping open. Role-gated controls are hidden, not
 * disabled. State lives in useExplorerTree.js and useImports.js.
 */

import { useState, useRef, useCallback } from "react";
import { moveItem } from "../../../api/documents";
import ContextMenu from "../../base/ContextMenu";
import Popover from "../../base/Popover";
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
  const [newMenu, setNewMenu] = useState(false);
  const newRef = useRef(null);
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
        {(can("createDocuments") || can("importDocuments")) && (
          <button
            ref={newRef}
            type="button"
            className="fe-new"
            aria-haspopup="menu"
            aria-expanded={newMenu}
            onClick={() => setNewMenu((v) => !v)}
            title={t("New")}
            aria-label={t("New")}
          >
            +
          </button>
        )}
        <Popover anchorRef={newRef} open={newMenu} onClose={() => setNewMenu(false)} align="end" ariaLabel={t("New")}>
          {can("createDocuments") && (
            <button type="button" role="menuitem" className="popover__item" onClick={() => { setNewMenu(false); tree.setPendingNew("file"); }}>
              {t("New document")}
            </button>
          )}
          {can("createDocuments") && (
            <button type="button" role="menuitem" className="popover__item" onClick={() => { setNewMenu(false); tree.setPendingNew("folder"); }}>
              {t("New folder")}
            </button>
          )}
          {can("importDocuments") && (
            <button type="button" role="menuitem" className="popover__item" onClick={() => { setNewMenu(false); pickFilesFor(""); }} title={t("Import files / packages (.zip, .apkg, .md)")}>
              {t("Import files")}
            </button>
          )}
          {can("createDocuments") && (
            <button type="button" role="menuitem" className="popover__item" onClick={() => { setNewMenu(false); openClip("", tree.loadRoot); }} title={t("Clip from URL (web article or YouTube)")}>
              {t("Clip from a web page")}
            </button>
          )}
        </Popover>
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
              {t("No files yet. Use + above to add one.")}
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
