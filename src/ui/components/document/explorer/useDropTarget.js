import { useState } from "react";
import { readTransfer } from "./dragDrop.js";

export default function useDropTarget({ onFiles, onMove }) {
  const [dragOver, setDragOver] = useState(false);
  const props = {
    onDragOver: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    },
    onDragLeave: (e) => {
      e.stopPropagation();
      setDragOver(false);
    },
    onDrop: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const { srcPath, isFolder, files } = readTransfer(e.dataTransfer);
      if (!srcPath) {
        if (files.length) await onFiles?.(files);
        return;
      }
      await onMove?.(srcPath, isFolder);
    },
  };
  return { dragOver, props };
}
