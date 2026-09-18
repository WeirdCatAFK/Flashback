/**
 * FolderNode — one folder row and, when open, its children. A drop target for
 * files (import) and tree items (move); a right-click hands the explorer what the
 * menu needs, including how to start an inline create inside it.
 */

import { useState, useEffect, useRef } from "react";
import {
  createFile,
  createFolder,
  deleteItem,
  moveItem,
} from "../../../api/documents";
import IconFolder from "../../icons/IconFolder";
import IconFolderOpen from "../../icons/IconFolderOpen";
import { useT } from "../../../translations/index";
import { childPath } from "./names.js";
import { writeTransfer, canDropInto, destPathFor } from "./dragDrop.js";
import useRename from "./useRename";
import useDropTarget from "./useDropTarget";
import useFolderChildren from "./useFolderChildren";
import FileNode from "./FileNode";
import { RenameInput, InlineCreate, ProgressBadge } from "./TreeParts";

export default function FolderNode({
  name,
  path,
  flashcardCount = 0,
  swatchColor = "",
  rollup = null,
  onRefresh,
  onSelect,
  onDoubleSelect,
  selectedPath,
  openPaths,
  toggleOpen,
  relocatePaths,
  onCtxMenu,
  onImportFiles,
}) {
  const { t } = useT();
  const open = openPaths.has(path);
  const selected = path === selectedPath;
  const nodeRef = useRef(null);
  const [pendingNew, setPendingNew] = useState(null);
  const { children, progress, loading, load } = useFolderChildren(path, open);
  const rename = useRename({
    name,
    path,
    isFolder: true,
    relocatePaths,
    onRenamed: onRefresh,
  });

  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const toggle = () => {
    if (!open) load();
    toggleOpen(path);
  };
  const refresh = () => {
    if (open) load();
    onRefresh();
  };

  const drop = useDropTarget({
    onFiles: async (files) => {
      await onImportFiles(files, path);
      refresh();
    },
    onMove: async (srcPath, isFolder) => {
      if (!canDropInto(srcPath, path)) return;
      const destPath = destPathFor(srcPath, path);
      try {
        await moveItem(srcPath, destPath, isFolder);
        relocatePaths(srcPath, destPath);
        refresh();
      } catch (err) {
        console.error("Move failed", err);
      }
    },
  });

  const startInlineCreate = async (kind) => {
    if (!open) {
      toggleOpen(path);
      await load();
    }
    setPendingNew(kind);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu(e, {
      isFolder: true,
      folderPath: path,
      folderColor: swatchColor,
      refresh,
      triggerRename: rename.start,
      doDelete: async () => {
        await deleteItem(path, true);
        onRefresh();
      },
      doNewFile: () => startInlineCreate("file"),
      doNewFolder: () => startInlineCreate("folder"),
    });
  };

  const handleInlineConfirm = async (newName) => {
    try {
      if (pendingNew === "folder") await createFolder(newName, path);
      else await createFile(newName, path);
      load();
    } catch (err) {
      console.error("Create failed", err);
    }
    setPendingNew(null);
  };

  const shared = {
    onRefresh: refresh,
    onSelect,
    onDoubleSelect,
    selectedPath,
    relocatePaths,
    onCtxMenu,
  };

  return (
    <div className="fe-folder-wrap">
      <div
        ref={nodeRef}
        className={`fe-folder${open ? " open" : ""}${selected ? " fe-selected" : ""}${drop.dragOver ? " fe-drag-over" : ""}`}
        draggable
        onDragStart={(e) => {
          writeTransfer(e.dataTransfer, { path, isFolder: true });
          e.stopPropagation();
        }}
        onContextMenu={handleContextMenu}
        {...drop.props}
      >
        <span className="fe-chevron" onClick={toggle} />
        {swatchColor && (
          <span
            className="fe-folder-swatch"
            style={{ background: swatchColor }}
          />
        )}
        <span className="fe-folder-icon" onClick={toggle}>
          {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        </span>
        <span className="fe-item-label" onClick={toggle}>
          {rename.renaming ? (
            <RenameInput inputProps={rename.inputProps} />
          ) : (
            name
          )}
        </span>
        <ProgressBadge rollup={rollup} />
        {flashcardCount > 0 && (
          <span className="badge fe-fc-badge">{flashcardCount}</span>
        )}
      </div>

      {open && (
        <div className="fe-children">
          {pendingNew && (
            <InlineCreate
              type={pendingNew}
              onConfirm={handleInlineConfirm}
              onCancel={() => setPendingNew(null)}
            />
          )}
          {loading && <span className="fe-loading">{t("Loading…")}</span>}
          {!loading &&
            children.map((item) =>
              item.type === "folder" ? (
                <FolderNode
                  key={item.name}
                  name={item.name}
                  path={childPath(path, item.name)}
                  flashcardCount={item.flashcardCount ?? 0}
                  swatchColor={item.metadata?.swatchColor ?? ""}
                  rollup={
                    progress?.folders?.[childPath(path, item.name)] ?? null
                  }
                  openPaths={openPaths}
                  toggleOpen={toggleOpen}
                  onImportFiles={onImportFiles}
                  {...shared}
                />
              ) : (
                <FileNode
                  key={item.name}
                  name={item.name}
                  path={childPath(path, item.name)}
                  globalHash={item.metadata?.globalHash}
                  progress={
                    progress?.documents?.[item.metadata?.globalHash] ?? null
                  }
                  flashcardCount={item.flashcardCount ?? 0}
                  {...shared}
                />
              ),
            )}
        </div>
      )}
    </div>
  );
}
