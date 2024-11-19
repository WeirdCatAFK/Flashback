import { useState, useEffect } from "react";
import "./FileRenderer.css";
import axios from "axios";
import QuillEditor from "./quill/quillEditor.jsx";

export default function FileRenderer({ selectedFile, sendEditorStats}) {
  const [fileData, setFileData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (selectedFile.id === 0) {
      setFileData(null);
      return;
    }

    setLoading(true);
    setError(null);

    axios
      .get(`http://localhost:50500/files/${selectedFile.id}`)
      .then((res) => {
        setFileData({
          content: res.data.content,
        });
      })
      .catch((err) => {
        console.error("Failed to get document data:", err);
        setError(err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [selectedFile.id]);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error loading file: {error.message}</div>;
  }

  if (!fileData) {
    return <EditorPlaceholder />;
  }

  return (
    <QuillEditor
      initialValue={fileData.content}
      name={selectedFile.name}
      onChange={() => {}}
      fileId={selectedFile.id}
      sendEditorStats = {sendEditorStats}
    />
  );
}

function EditorPlaceholder() {
  return (
    <div className="placeholder">
      <h1>Select a File</h1>
    </div>
  );
}
