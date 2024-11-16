import "./Documents.css";
import React, { useState, useEffect } from "react";
import FileExplorer from "./../components/FileExplorer.jsx";
import FileRenderer from "./../components/FileRenderer.jsx";
import FlashcardMaker from "./../components/FlashcardMaker.jsx";
import axios from "axios";

function DocumentView() {
  const [selectedFile, setSelectedFile] = useState({ id: 0, presence: 0 });
  const [fileTree, setFileTree] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    axios.get("http://localhost:50500/files/tree")
      .then((response) => {
        // Access the tree property from the response data
        setFileTree(response.data.tree);
      })
      .catch((error) => {
        console.error(error);
        setError("Failed to load file tree");
      });
  }, []);

  function handleFileSelect(fileData) {
    setSelectedFile(fileData);
  }

  // Show loading state while waiting for the data
  if (!fileTree) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  return (
    <div className="document-view">
      <div className="file-explorer">
        <FileExplorer 
          tree={fileTree}  // This is now the correct tree structure
          sendFileID={handleFileSelect} 
        />
      </div>
      <div>
        <p>{selectedFile.id}</p>
      </div>
      <div className="file-renderer">
        <FileRenderer file={selectedFile} />
      </div>
      <div className="flashcard-maker">
        <FlashcardMaker file={selectedFile} />
      </div>
    </div>
  );
}

export default DocumentView;