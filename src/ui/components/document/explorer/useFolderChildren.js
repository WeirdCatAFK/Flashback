import { useState, useEffect, useRef, useCallback } from "react";
import { listFolder } from "../../../api/documents";
import { listProgress } from "../../../api/progress";
import { sortItems, childPath } from "./names.js";

export default function useFolderChildren(path, open) {
  const [children, setChildren] = useState([]);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = sortItems(await listFolder(path));
      setChildren(items);
      const folders = items
        .filter((i) => i.type === "folder")
        .map((i) => childPath(path, i.name));
      listProgress(path, folders)
        .then(setProgress)
        .catch(() => setProgress(null));
    } catch (err) {
      console.error("Load failed", err);
    } finally {
      setLoading(false);
    }
  }, [path]);

  const wasOpenOnMount = useRef(open);
  useEffect(() => {
    if (wasOpenOnMount.current) load();
  }, [load]);

  return { children, progress, loading, load };
}
