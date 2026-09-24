/**
 * FileNode — one document row: icon, name without its extension (or the rename
 * box), card count, and a thin line under it for how far it has been read.
 * Draggable; a right-click hands the explorer what the menu needs.
 */

import { useEffect, useRef } from "react";
import { deleteItem } from "../../../api/documents";
import getFileIcon from "../../icons/fileIconMap";
import { writeTransfer } from "./dragDrop.js";
import useRename from "./useRename";
import { RenameInput, ReadLine, CardCount } from "./TreeParts";
import { docStem, docKind, readFacts } from "./rowFacts.js";
import { useT } from "../../../translations/index";

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
  const { t, tp } = useT();
  const FileIcon = getFileIcon(name);
  const selected = path === selectedPath;
  const facts = readFacts({ progress }, t);
  const tip = [name, facts.label, flashcardCount ? tp("{n} card", "{n} cards", flashcardCount) : null].filter(Boolean).join(" · ");
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
      className={`fe-file${selected ? " fe-selected" : ""}${facts.finished ? " fe-finished" : ""}`}
      title={tip}
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
      <span className="fe-chevron-space" />
      <FileIcon />
      <span className="fe-item-label">
        {rename.renaming ? (
          <RenameInput inputProps={rename.inputProps} />
        ) : (
          docStem(name)
        )}
      </span>
      <span className="fe-kind">{docKind(name)}</span>
      <CardCount n={flashcardCount} />
      <ReadLine facts={facts} />
    </div>
  );
}
