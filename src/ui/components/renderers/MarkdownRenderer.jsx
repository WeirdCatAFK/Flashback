import { useEffect, useRef, useState } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import { readFile, updateFile } from "../../api/documents";
import "./MarkdownRenderer.css";

export default function MarkdownRenderer({ path }) {
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  const editorContainerRef = useRef(null);
  const vditorInstanceRef = useRef(null);

  const handleSave = async () => {
    if (!vditorInstanceRef.current) return;
    setIsSaving(true);
    setError(null);
    try {
      const currentContent = vditorInstanceRef.current.getValue();
      await updateFile(path, currentContent);
    } catch (err) {
      setError(err.message || "Failed to save file.");
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (!path) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

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

    readFile(path)
      .then((data) => {
        if (!isMounted) return;

        const initialContent = data.content ?? "";
        const editorTheme = getComputedStyle(document.documentElement)
          .getPropertyValue("--color-bg-editor").trim() || "dark";

        const vditor = new Vditor(editorContainerRef.current, {
          value: initialContent,
          mode: "ir",
          theme: editorTheme,
          cache: { enable: false },
          toolbarConfig: { pin: true },
          toolbar: [
            "headings", "bold", "italic", "strike", "link", "|",
            "list", "ordered-list", "check", "outdent", "indent", "|",
            "quote", "line", "code", "inline-code", "insert-before", "insert-after", "|",
            "table", "undo", "redo", "|",
            "fullscreen", "edit-mode",
            {
              name: "save",
              tip: "Save (Ctrl+S)",
              icon: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
              click: () => handleSave(),
            },
          ],
          height: "100%",
          after: () => {
            if (isMounted) {
              vditorInstanceRef.current = vditor;
              setLoading(false);
            }
          },
        });
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message || "Could not load file.");
          setLoading(false);
        }
      });

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
      {error && <div className="editor-error-banner">{error}</div>}
      <div className="editor-content-wrapper">
        {loading && (
          <div className="editor-loading-overlay">Loading Editor…</div>
        )}
        <div ref={editorContainerRef} className="vditor-wrapper" />
      </div>
    </div>
  );
}