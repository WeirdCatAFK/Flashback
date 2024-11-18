import "./Documents.css";
import React, { useState, useEffect } from "react";
import FileExplorer from "./../components/FileExplorer.jsx";
import FileRenderer from "./../components/FileRenderer.jsx";
import FlashcardMaker from "./../components/FlashcardMaker.jsx";
import axios from "axios";

function DocumentView() {
  // These id values are relative to the db
  const [selectedFile, setSelectedFile] = useState({ id: 0 });
  const [selectedFolder, setSelectedFolder] = useState({ id: 0 });
  const [updateStatus, setUpdateStatus] = useState(true);

  // These will be loaded with request to the backend server
  const [fileTree, setFileTree] = useState(null);
  const [error, setError] = useState(null);

  // Get the current file tree on the workspace
  useEffect(() => {
    if (updateStatus) {
      axios
        .get("http://localhost:50500/files/tree")
        .then((response) => {
          // Access the tree property from the response data
          setFileTree(response.data.tree);
          setUpdateStatus(false);
          console.log("updated!");
        })
        .catch((error) => {
          console.error(error);
          setError("Failed to load file tree");
        });
    }
  }, [updateStatus]); // Depend on updateStatus to refetch when it changes

  function handleFileSelect(fileData) {
    setSelectedFile(fileData);
  }

  function handleFolderSelect(folderData) {
    setSelectedFolder(folderData);
  }

  function handleUpdateStatus(boolean) {
    setUpdateStatus(boolean);
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
          tree={fileTree} // This is now the correct tree structure
          sendFileID={handleFileSelect}
          sendFolderID={handleFolderSelect}
          sendRefreshStatus={handleUpdateStatus}
        />
      </div>
      <div>
        <p>
          Selected File: {selectedFile.id}
          <br />
          Selected Folder: {selectedFolder.id}
        </p>
      </div>
      <div className="file-renderer">
        <FileRenderer file={selectedFile} sendRefreshStatus={handleUpdateStatus} />
      </div>
      <div className="flashcard-maker">
        <FlashcardMaker file={selectedFile} sendRefreshStatus={handleUpdateStatus} />
      </div>
    </div>
  );
}

export default DocumentView;
