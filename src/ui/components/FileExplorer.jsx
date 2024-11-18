import { useState } from "react";
import axios from "axios";
import "./FileExplorer.css";

export default function FileExplorer({
  tree,
  sendFileID,
  sendFolderID,
  sendRefreshStatus,
}) {
  const [expand, setExpand] = useState(false);

  if (tree.key === 0) {
    async function handleOnDrop(e) {
      // Only handle if it's dropped directly on root (not bubbled)
      if (e.target.closest(".root-folder")) {
        const dragged_id = e.dataTransfer.getData("id");
        const isFolder = e.dataTransfer.getData("isFolder") === "true";

        try {
          const response = await axios.post(
            `http://localhost:50500/files${
              isFolder ? "/folder" : ""
            }/${dragged_id}/move/0`
          );
          console.log(
            `${isFolder ? "Folder" : "File"} moved successfully:`,
            response.data
          );
          sendRefreshStatus(true);
        } catch (error) {
          console.error(
            `Error moving ${isFolder ? "folder" : "file"}:`,
            error.response ? error.response.data : error.message
          );
        }
      }
    }

    function handleOnDragOver(e) {
      e.preventDefault();
    }

    return (
      <RootFolder
        sendRefreshStatus={sendRefreshStatus}
        onDrop={handleOnDrop}
        onDragOver={handleOnDragOver}
      >
        {tree.items.map((item) => (
          <FileExplorer
            key={item.key}
            tree={item}
            sendFileID={sendFileID}
            sendFolderID={sendFolderID}
            sendRefreshStatus={sendRefreshStatus}
          />
        ))}
      </RootFolder>
    );
  }

  if (tree.is_folder) {
    function toggle() {
      setExpand(!expand);
    }
    return (
      <Folder
        name={tree.name}
        isOpen={expand}
        onToggle={toggle}
        id={tree.id}
        sendFolderID={sendFolderID}
        sendRefreshStatus={sendRefreshStatus}
      >
        {tree.items.map((item) => (
          <FileExplorer
            key={item.key}
            tree={item}
            sendFileID={sendFileID}
            sendFolderID={sendFolderID}
            sendRefreshStatus={sendRefreshStatus}
          />
        ))}
      </Folder>
    );
  }

  return (
    <File
      name={tree.name}
      id={tree.id}
      onFileClick={sendFileID}
      sendRefreshStatus={sendRefreshStatus}
    />
  );
}

const File = ({ name, id, onFileClick, sendRefreshStatus }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(name);

  function handleOnDragStart(e, id, isFolder) {
    e.dataTransfer.setData("id", id);
    e.dataTransfer.setData("isFolder", isFolder);
  }

  function handleClick() {
    if (!isRenaming) {
      onFileClick({ id });
    }
  }

  function handleRightClick(e) {
    e.preventDefault();
    setIsRenaming(true);
  }

  async function handleDelete(e) {
    e.stopPropagation(); // Prevent file selection when deleting

    if (window.confirm(`Are you sure you want to delete ${name}?`)) {
      try {
        await axios.delete(`http://localhost:50500/files/${id}`);
        console.log("File deleted successfully");
        sendRefreshStatus(true);
      } catch (error) {
        console.error("Failed to delete file:", error);
      }
    }
  }

  async function handleRename(e) {
    if (e.key === "Enter") {
      try {
        await axios.put(`http://localhost:50500/files/${id}/rename`, {
          rename: newName,
        });
        setIsRenaming(false);
        sendRefreshStatus(true);
      } catch (error) {
        console.error("Failed to rename file:", error);
        setNewName(name);
      }
    } else if (e.key === "Escape") {
      setIsRenaming(false);
      setNewName(name);
    }
  }

  return (
    <div
      className="file"
      onClick={handleClick}
      onContextMenu={handleRightClick}
      draggable
      onDragStart={(e) => handleOnDragStart(e, id, false)}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        minWidth: 0, // This allows flex items to shrink below their minimum content size
      }}
    >
      <div
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexGrow: 1,
          minWidth: 0, // Allows text to truncate
        }}
      >
        {isRenaming ? (
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleRename}
            onBlur={() => {
              setIsRenaming(false);
              setNewName(name);
            }}
            autoFocus
            style={{ width: "100%" }}
          />
        ) : (
          <>📄 {name}</>
        )}
      </div>
      <button
        onClick={handleDelete}
        className="delete-btn"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#ff4444",
          padding: "2px 6px",
          marginLeft: "8px",
          visibility: "hidden",
          flexShrink: 0,
        }}
      >
        🗑️
      </button>
    </div>
  );
};

const Folder = ({
  name,
  isOpen,
  onToggle,
  children,
  id,
  sendFolderID,
  sendRefreshStatus,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(name);
  async function handleDelete(e) {
    e.stopPropagation(); // Prevent folder toggle when deleting

    if (
      window.confirm(
        `Are you sure you want to delete folder ${name} and all its contents?`
      )
    ) {
      try {
        await axios.delete(`http://localhost:50500/files/folder/${id}`);
        console.log("Folder deleted successfully");
        sendRefreshStatus(true);
      } catch (error) {
        console.error("Failed to delete folder:", error);
      }
    }
  }

  async function handleOnDrop(e) {
    // Stop event from bubbling to parent folders
    e.stopPropagation();

    const dragged_id = e.dataTransfer.getData("id");
    const isFolder = e.dataTransfer.getData("isFolder") === "true";

    try {
      const response = await axios.post(
        `http://localhost:50500/files${
          isFolder ? "/folder" : ""
        }/${dragged_id}/move/${id}`
      );
      console.log(
        `${isFolder ? "Folder" : "File"} moved successfully:`,
        response.data
      );
      sendRefreshStatus(true);
    } catch (error) {
      console.error(
        `Error moving ${isFolder ? "folder" : "file"}:`,
        error.response ? error.response.data : error.message
      );
    }
  }

  function handleOnDragStart(e, id, isFolder) {
    e.dataTransfer.setData("id", id);
    e.dataTransfer.setData("isFolder", isFolder);
  }

  function handleOnDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleClick() {
    if (!isRenaming) {
      onToggle();
      sendFolderID({ id });
    }
  }

  function handleRightClick(e) {
    e.preventDefault();
    setIsRenaming(true);
  }

  async function handleRename(e) {
    if (e.key === "Enter") {
      try {
        await axios.put(`http://localhost:50500/files/folder/${id}/rename`, {
          rename: newName,
        });
        setIsRenaming(false);
        sendRefreshStatus(true);
      } catch (error) {
        console.error("Failed to rename folder:", error);
        setNewName(name);
      }
    } else if (e.key === "Escape") {
      setIsRenaming(false);
      setNewName(name);
    }
  }

  return (
    <div
      style={{ backgroundColor: "#CED4DA", height: "100%", maxWidth: "100%" }}
    >
      <div
        className={`folder ${isOpen ? "open" : ""}`}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        draggable
        onDragStart={(e) => handleOnDragStart(e, id, true)}
        onDrop={handleOnDrop}
        onDragOver={handleOnDragOver}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          minWidth: 0, // Allow flex items to shrink below their minimum content size
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flexGrow: 1,
            minWidth: 0, // Allows text to truncate
          }}
        >
          {isRenaming ? (
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleRename}
              onBlur={() => {
                setIsRenaming(false);
                setNewName(name);
              }}
              autoFocus
              style={{ width: "100%" }}
            />
          ) : (
            <>📁 {name}</>
          )}
        </span>
        <button
          onClick={handleDelete}
          className="delete-btn"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#ff4444",
            padding: "2px 6px",
            marginLeft: "8px",
            visibility: "hidden",
            flexShrink: 0, // Prevent button from shrinking
          }}
        >
          🗑️
        </button>
      </div>

      <div
        style={{
          paddingLeft: 1,
          maxWidth: "100%",
          display: isOpen ? "block" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
};
const RootFolder = ({ children, sendRefreshStatus, onDrop, onDragOver }) => {
  const [isDragging, setIsDragging] = useState(false);

  async function handleCreateFolderClick() {
    try {
      await axios.post("http://localhost:50500/files/folder/new_folder");
      sendRefreshStatus(true);
    } catch (error) {
      console.error("Failed to create new folder:", error);
    }
  }

  async function handleCreateFileClick() {
    try {
      await axios.post("http://localhost:50500/files/new_file");
      sendRefreshStatus(true);
    } catch (error) {
      console.error("Failed to create new file:", error);
    }
  }

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDragOver(e);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    // Check if it's an internal drag operation
    const draggedId = e.dataTransfer.getData("id");
    if (draggedId) {
      onDrop(e);
      return;
    }

    // Handle file upload
    const files = Array.from(e.dataTransfer.files);

    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);

      try {
        await axios.post("http://localhost:50500/upload", formData, {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        });
        console.log("File uploaded successfully:", file.name);
        sendRefreshStatus(true);
      } catch (error) {
        console.error("Error uploading file:", error);
      }
    }
  };

  return (
    <div
      className="root-folder"
      style={{
        backgroundColor: "#CED4DA",
        height: "100%",
        maxWidth: "100%",
        position: "relative",
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.1)",
            border: "2px dashed #666",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              padding: "20px",
              backgroundColor: "white",
              borderRadius: "8px",
              boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
            }}
          >
            Drop files here to upload
          </div>
        </div>
      )}
      <div className="header-cont">
        <div className="workspace-name-cont">
          <span className="workspace-name">Flashback</span>
        </div>
        <div className="create-fold-cont">
          <button className="create-fold-btn" onClick={handleCreateFolderClick}>
            +📂
          </button>
        </div>
        <div className="create-doc-container">
          <button className="create-doc-btn" onClick={handleCreateFileClick}>
            +📄
          </button>
        </div>
      </div>

      <div style={{ paddingLeft: 1, maxWidth: "100%" }}>{children}</div>
    </div>
  );
};
