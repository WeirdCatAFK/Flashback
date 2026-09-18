/**
 * The tree's root: the top-level listing and its progress, the remount counter
 * that refreshes every open subtree after a rollback or an import, and inline
 * creation at the root.
 */

import { useState, useEffect, useCallback } from "react";
import { listFolder, createFile, createFolder } from "../../../api/documents";
import { listProgress } from "../../../api/progress";
import { useDataInvalidation } from "../../../utils/dataBus";
import { sortItems } from "./names.js";

export default function useExplorerTree() {
  const [items, setItems] = useState([]);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);
  const [pendingNew, setPendingNew] = useState(null);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const rootItems = sortItems(await listFolder(""));
      setItems(rootItems);
      const folders = rootItems
        .filter((i) => i.type === "folder")
        .map((i) => i.name);
      listProgress("", folders)
        .then(setProgress)
        .catch(() => setProgress(null));
    } catch (err) {
      console.error("Load root failed", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);
  useDataInvalidation(() => {
    loadRoot();
    setTreeVersion((v) => v + 1);
  });

  const createAtRoot = async (newName) => {
    try {
      if (pendingNew === "folder") await createFolder(newName, "");
      else await createFile(newName, "");
      loadRoot();
    } catch (err) {
      console.error("Create failed", err);
    }
    setPendingNew(null);
  };

  return {
    items,
    progress,
    loading,
    error,
    treeVersion,
    loadRoot,
    pendingNew,
    setPendingNew,
    createAtRoot,
  };
}
