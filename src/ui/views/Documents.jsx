import "./Documents.css";

import React, { useState } from 'react';

import FileExplorer from "./../components/FileExplorer.jsx";
import FileRenderer from "./../components/FileRenderer.jsx";
import FlashcardMaker from "./../components/FlashcardMaker.jsx";
import api_tree from './../../data/folderData.js';

function DocumentView() {
  const [selectedFile, setSelectedFile] = useState(null);

  const handleFileSelect = (fileData) => {
    setSelectedFile(fileData);
  };

  return (
    <div className="document-view">
      <div className="file-explorer">
        <FileExplorer tree={api_tree.tree}  onFileSelect={handleFileSelect} />
      </div>
      <div className="file-renderer">
        <FileRenderer file={selectedFile} />
      </div>
      <div className="flashcard'maker">
        <FlashcardMaker file={selectedFile} />
      </div>
    </div>
  );
}

export default DocumentView;
