import { useState } from "react";
import "./FileExplorer.css";

export default function FileExplorer({ tree, sendFileID }) {
  //On this context id's are relative to the db, not as an element of the dom
  const [expand, setExpand] = useState(false);

  function handleClick(fileData) {
    sendFileID(fileData);
  }

  if (tree.key == 0) {
    //If node is the first, only render it's contents
    {
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
            {tree.items.map((item) => {
              return (
                <FileExplorer
                  key={item.key}
                  tree={item}
                  sendFileID={sendFileID}
                />
              );
            })}
          </div>
        </div>
      );
    }
  }
  if (tree.is_folder) {
    return (
      <div
        style={{ backgroundColor: "#CED4DA", height: "100%", maxWidth: "100%" }}
      >
        <div
          className={`folder ${expand ? "open" : ""}`}
          onClick={() => setExpand(!expand)}
        >
          <span>📁 {tree.name}</span>
        </div>

        <div
          style={{
            paddingLeft: 1,
            maxWidth: "100%",
            display: expand ? "block" : "none",
          }}
        >
          {tree.items.map((item) => {
            return (
              <FileExplorer
                key={item.key}
                tree={item}
                sendFileID={sendFileID}
              />
            );
          })}
        </div>
      </div>
    );
  } else {
    return (
      <div
        className="file"
        onClick={() => {
          tree.id;
          const fileData = {
            id: tree.id,
            presence: tree.presence,
          };
          handleClick(fileData);
        }}
      >
        📄 {tree.name}
      </div>
    );
  }
}
