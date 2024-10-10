const fs = require("fs");
const path = require("path");

class FileManager {
  constructor() {
    const config = JSON.parse(
      fs.readFileSync("./data/config.json", "utf8")
    ).config;
    const currentWorkspace = config.workspaces.find(
      (workspace) => workspace.id === config.current.workspace_id
    );

    if (!currentWorkspace) {
      throw new Error("Current workspace not found in config.");
    }

    // Check if the path is absolute, if not resolve it to the project directory
    this.filesPath = path.isAbsolute(currentWorkspace.path)
      ? currentWorkspace.path
      : // Resolve relative paths within the project's directory on the context of flashback as a whole, not on the api
        path.resolve(__dirname, "../../", currentWorkspace.path);
  }

  async ensureDirectoryExists() {
    if (!fs.existsSync(this.filesPath)) {
      fs.mkdirSync(this.filesPath, { recursive: true });
      console.log("Created workspace files directory:", this.filesPath);
    }
  }

  loadDocument(fileName) {
    const filePath = path.join(this.filesPath, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `File ${fileName} not found in workspace with path ${filePath}`
      );
    }
    return fs.readFileSync(filePath, "utf8");
  }

  saveDocument(fileName, content) {
    const filePath = path.join(this.filesPath, fileName);
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`File ${fileName} saved in workspace.`);
  }

  deleteDocument(fileName) {
    const filePath = path.join(this.filesPath, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`File ${fileName} deleted from workspace.`);
    } else {
      throw new Error(`File ${fileName} not found.`);
    }
  }
}

const fileManager = new FileManager();
module.exports = fileManager;
