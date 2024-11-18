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
  //Root Folder 📂
  if (tree.key === 0) {
    return (
      <RootFolder sendRefreshStatus={sendRefreshStatus}>
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
  //Folder 📁
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
  //File 📄
  return (
    <File
      name={tree.name}
      id={tree.id}
      onFileClick={sendFileID}
      sendRefreshStatus={sendRefreshStatus}
    />
  );
}

//File component 📄
const File = ({ name, id, onFileClick, sendRefreshStatus }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(name);

  function handleClick() {
    if (!isRenaming) {
      onFileClick({ id });
    }
  }

  function handleRightClick(e) {
    e.preventDefault();
    setIsRenaming(true);
  }

  async function handleRename(e) {
    if (e.key === "Enter") {
      try {
        await axios.put(`http://localhost:50500/files/${id}/rename`, {
          rename: newName,
        });
        setIsRenaming(false);
        sendRefreshStatus(true);
        ``;
      } catch (error) {
        console.error("Failed to rename file:", error);
        setNewName(name); // Reset to original name if failed
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
        />
      ) : (
        <>📄 {name}</>
      )}
    </div>
  );
};

//Folder component

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
      >
        <span>
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
            />
          ) : (
            <>📁 {name}</>
          )}
        </span>
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

//Root Folder 📂
const RootFolder = ({ children, sendRefreshStatus }) => {
  function handleCreateFolderClick() {
    sendRefreshStatus(true);
  }

  function handleCreateFileClick() {
    sendRefreshStatus(true);
  }

  return (
    <div
      style={{ backgroundColor: "#CED4DA", height: "100%", maxWidth: "100%" }}
    >
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
