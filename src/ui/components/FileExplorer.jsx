import { useState } from "react";
import "./FileExplorer.css";

const File = ({ name, id, presence, onFileClick }) => {
  const handleClick = () => {
    onFileClick({ id, presence });
  };

  return (
    <div className="file" onClick={handleClick}>
      📄 {name}
    </div>
  );
};

const Folder = ({ name, isOpen, onToggle, children }) => {
  return (
    <div style={{ backgroundColor: "#CED4DA", height: "100%", maxWidth: "100%" }}>
      <div
        className={`folder ${isOpen ? "open" : ""}`}
        onClick={onToggle}
      >
        <span>📁 {name}</span>
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

const RootFolder = ({ children }) => {
  return (
    <div
      style={{
        backgroundColor: "#CED4DA",
        height: "100%",
        maxWidth: "100%",
      }}
    >
      <div
        style={{
          paddingLeft: 1,
          maxWidth: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default function FileExplorer({ tree, sendFileID }) {
  const [expand, setExpand] = useState(false);

  if (tree.key === 0) {
    return (
      <RootFolder>
        {tree.items.map((item) => (
          <FileExplorer
            key={item.key}
            tree={item}
            sendFileID={sendFileID}
          />
        ))}
      </RootFolder>
    );
  }

  if (tree.is_folder) {
    return (
      <Folder
        name={tree.name}
        isOpen={expand}
        onToggle={() => setExpand(!expand)}
      >
        {tree.items.map((item) => (
          <FileExplorer
            key={item.key}
            tree={item}
            sendFileID={sendFileID}
          />
        ))}
      </Folder>
    );
  }

  return (
    <File
      name={tree.name}
      id={tree.id}
      presence={tree.presence}
      onFileClick={sendFileID}
    />
  );
}