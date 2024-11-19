import React, { useRef, useState, useEffect } from "react";
import ReactQuill from "react-quill";
import axios from "axios";
import "react-quill/dist/quill.snow.css";

// Constants remain the same
const EDITOR_CONFIG = {
  modules: {
    toolbar: [
      [{ header: [1, 2, 3, false] }],
      ["bold", "italic", "underline", "strike"],
      [{ list: "ordered" }, { list: "bullet" }],
      [{ color: [] }, { background: [] }],
      ["clean"],
      ["link"],
    ],
  },
  formats: [
    "header",
    "bold",
    "italic",
    "underline",
    "strike",
    "list",
    "bullet",
    "color",
    "background",
    "link",
  ],
};

const SAVE_DELAY = 2000;
const API_BASE_URL = "http://localhost:50500";

const INITIAL_EDITOR_STATE = {
  content: {
    value: "",
    lastChange: null,
    length: 0,
  },
  selection: {
    range: null,
    bounds: null,
  },
  document: {
    fileName: null,
    lastSaved: null,
    saveStatus: "",
    isDirty: false,
  },
};

const styles = `
  .editor-wrapper {
    min-height: 100%;
    min-width: 100%;
    display: flex;
    flex-direction: column;
  }
  
  .editor-wrapper .quill {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  
  .editor-wrapper .ql-container {
    flex: 1;
    overflow-y: auto;
  }
  
  .editor-wrapper .ql-toolbar {
    flex-shrink: 0;
  }

  .editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px;
    background-color: #f8f9fa;
    border-bottom: 1px solid #e2e8f0;
  }

  .save-status {
    font-size: 0.875rem;
    color: #718096;
  }

  .editor-wrapper .ql-editor {
    min-height: 100%;
  }
`;

const QuillEditor = ({ initialValue = "", onChange, fileId, sendEditorStats }) => {
  const [editorStats, setEditorStats] = useState({
    ...INITIAL_EDITOR_STATE,
    content: {
      ...INITIAL_EDITOR_STATE.content,
      value: initialValue,
    },
  });

  const quillRef = useRef(null);
  const saveTimeoutRef = useRef(null);

  // Updated state updaters to trigger sendEditorStats
  const updateEditorStats = (updates) => {
    setEditorStats((prevState) => {
      const newState = {
        ...prevState,
        ...updates,
      };
      // Send updated stats after state update
      if (sendEditorStats) {
        sendEditorStats(newState);
      }
      return newState;
    });
  };

  const updateContent = (updates) => {
    updateEditorStats({
      content: {
        ...editorStats.content,
        ...updates,
      },
    });
  };

  const updateDocument = (updates) => {
    updateEditorStats({
      document: {
        ...editorStats.document,
        ...updates,
      },
    });
  };

  const updateSelection = (updates) => {
    updateEditorStats({
      selection: {
        ...editorStats.selection,
        ...updates,
      },
    });
  };

  // API Calls
  const fetchFileName = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/files/${fileId}/name`);
      if (response.data.code === 200) {
        updateDocument({
          fileName: response.data.name,
        });
      }
    } catch (err) {
      console.error("Failed to get document name:", err);
      updateDocument({
        saveStatus: "Failed to load document name",
      });
    }
  };

  const saveContent = async () => {
    try {
      updateDocument({ saveStatus: "Saving..." });

      const response = await axios.put(
        `${API_BASE_URL}/files/${fileId}/write`,
        { content: editorStats.content.value },
        { headers: { "Content-Type": "application/json" } }
      );

      if (response.data.code === 200) {
        updateDocument({
          lastSaved: new Date(),
          saveStatus: "Saved",
          isDirty: false,
        });
        setTimeout(() => updateDocument({ saveStatus: "" }), 10000);
      } else {
        throw new Error(response.data.error || "Save failed");
      }
    } catch (error) {
      console.error("Save failed:", error);
      updateDocument({ saveStatus: "Save failed!" });
      setTimeout(() => updateDocument({ saveStatus: "" }), 10000);
    }
  };

  // Event Handlers
  const handleChange = (value, delta, source, editor) => {
    const updates = {
      value: value,
      lastChange: delta,
      length: editor.getLength(),
    };
    
    updateContent(updates);
    updateDocument({ isDirty: true });

    if (onChange) {
      onChange(value);
    }
    
    debounceSave();
  };

  const handleSelectionChange = (range, source, editor) => {
    updateSelection({
      range: range,
      bounds: range ? editor.getBounds(range.index, range.length) : null,
    });
  };

  const debounceSave = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(saveContent, SAVE_DELAY);
  };

  // Effects
  useEffect(() => {
    if (fileId) {
      fetchFileName();
    }
  }, [fileId]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        if (editorStats.document.isDirty) {
          saveContent();
        }
      }
    };
  }, [editorStats.document.isDirty]);

  useEffect(() => {
    if (quillRef.current) {
      const editor = quillRef.current.getEditor();
      updateContent({ length: editor.getLength() });
    }
  }, []);

  const renderHeader = () => (
    <div className="editor-header">
      <div className="font-medium">{editorStats.document.fileName}</div>
      <div className="save-status">
        {editorStats.document.saveStatus}
        {editorStats.document.lastSaved && !editorStats.document.saveStatus && (
          <span>
            Last saved: {editorStats.document.lastSaved.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="editor-wrapper h-full flex flex-col">
      <style>{styles}</style>
      {renderHeader()}
      <ReactQuill
        ref={quillRef}
        value={editorStats.content.value}
        onChange={handleChange}
        onChangeSelection={handleSelectionChange}
        modules={EDITOR_CONFIG.modules}
        formats={EDITOR_CONFIG.formats}
        theme="snow"
        className="h-full"
      />
    </div>
  );
};

export default QuillEditor;