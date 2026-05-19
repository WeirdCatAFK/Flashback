import { useEffect, useRef, useState } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import { readFile, updateFile } from "../../api/documents";
import "./MarkdownRenderer.css";

export default function MarkdownRenderer({ path, onDirtyChange, saveRef, draftContent, onDraftChange }) {
  const [loading, setLoading] = useState(true);

  const editorContainerRef = useRef(null);
  const vditorInstanceRef  = useRef(null);
  const isDirtyRef         = useRef(false);
  // Snapshot of draftContent read once per path change — never drives re-runs
  const draftRef = useRef(draftContent);
  draftRef.current = draftContent;

  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    if (!vditorInstanceRef.current) return;
    try {
      const currentContent = vditorInstanceRef.current.getValue();
      await updateFile(path, currentContent);
      isDirtyRef.current = false;
      onDirtyChange?.(path, false);
      onDraftChange?.(path, undefined); // clear draft — file matches disk
    } catch {
      // dirty dot stays; user can retry with Ctrl+S
    }
  };

  const handleSave = () => handleSaveRef.current?.();

  // Let DocumentEditor trigger save via saveRef
  useEffect(() => {
    if (saveRef) saveRef.current = handleSave;
    return () => { if (saveRef) saveRef.current = null; };
  });

  useEffect(() => {
    if (!path) return;

    let isMounted = true;
    const draft = draftRef.current; // snapshot — stable for this path

    if (draft === undefined) {
      // Fresh load: show overlay and reset dirty
      setLoading(true);
      isDirtyRef.current = false;
      onDirtyChange?.(path, false);
    }
    // If restoring a draft, loading stays false (no overlay flash) and dirty
    // state is already preserved in DocumentEditor's dirtyPaths Set.

    if (vditorInstanceRef.current) {
      vditorInstanceRef.current.destroy();
      vditorInstanceRef.current = null;
    }

    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    editorContainerRef.current.addEventListener("keydown", handleKeyDown);

    const initVditor = (seedContent) => {
      if (!isMounted) return;
      const editorTheme = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-bg-editor").trim() || "dark";

      const vditor = new Vditor(editorContainerRef.current, {
        value: seedContent,
        mode: "ir",
        theme: editorTheme,
        cache: { enable: false },
        input: (value) => {
          if (!isDirtyRef.current) {
            isDirtyRef.current = true;
            onDirtyChange?.(path, true);
          }
          onDraftChange?.(path, value);
        },
        toolbar: [],
        height: "100%",
        after: () => {
          if (isMounted) {
            vditorInstanceRef.current = vditor;
            setLoading(false);
          }
        },
      });
    };

    if (draft !== undefined) {
      isDirtyRef.current = true; // draft implies unsaved changes
      initVditor(draft);
    } else {
      readFile(path)
        .then((data) => initVditor(data.content ?? ""))
        .catch(() => { if (isMounted) setLoading(false); });
    }

    return () => {
      isMounted = false;
      editorContainerRef.current?.removeEventListener("keydown", handleKeyDown);
      if (vditorInstanceRef.current) {
        vditorInstanceRef.current.destroy();
        vditorInstanceRef.current = null;
      }
    };
  }, [path]);

  return (
    <div className="markdown-editor-container">
      <div className="editor-content-wrapper">
        {loading && (
          <div className="editor-loading-overlay">Loading Editor…</div>
        )}
        <div ref={editorContainerRef} className="vditor-wrapper" />
      </div>
    </div>
  );
}