/**
 * FileNode — one document row: icon, name (or its rename box), reading badge and
 * card count. Draggable; a right-click hands the explorer what the menu needs.
 */

import { useEffect, useRef } from "react";
import { deleteItem } from "../../../api/documents";
import getFileIcon from "../../icons/fileIconMap";
import { writeTransfer } from "./dragDrop.js";
import useRename from "./useRename";
import { RenameInput, ProgressBadge } from "./TreeParts";

export default function FileNode({
  name,
  path,
  globalHash,
  flashcardCount = 0,
  progress = null,
  onRefresh,
  onSelect,
  onDoubleSelect,
  selectedPath,
  relocatePaths,
  onCtxMenu,
}) {
  const FileIcon = getFileIcon(name);
  const selected = path === selectedPath;
  const nodeRef = useRef(null);
  const rename = useRename({
    name,
    path,
    isFolder: false,
    relocatePaths,
    onRenamed: onRefresh,
  });

  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu(e, {
      isFolder: false,
      filePath: path,
      triggerRename: rename.start,
      doDelete: async () => {
        await deleteItem(path, false);
        onRefresh();
      },
    });
  };

  return (
    <div
      ref={nodeRef}
      className={`fe-file${selected ? " fe-selected" : ""}`}
      draggable
      onDragStart={(e) => {
        writeTransfer(e.dataTransfer, {
          path,
          isFolder: false,
          globalHash,
          name,
        });
        e.stopPropagation();
      }}
      onClick={() => !rename.renaming && onSelect?.(path)}
      onDoubleClick={() => !rename.renaming && onDoubleSelect?.(path)}
      onContextMenu={handleContextMenu}
    >
      <FileIcon size={14} />
      <span className="fe-item-label">
        {rename.renaming ? (
          <RenameInput inputProps={rename.inputProps} />
        ) : (
          name
        )}
      </span>
      <ProgressBadge progress={progress} />
      {flashcardCount > 0 && (
        <span className="badge fe-fc-badge">{flashcardCount}</span>
      )}
    </div>
  );
}
