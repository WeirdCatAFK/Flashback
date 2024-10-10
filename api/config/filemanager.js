const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

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

    this.filesPath = path.isAbsolute(currentWorkspace.path)
      ? currentWorkspace.path
      : path.resolve(__dirname, "../../", currentWorkspace.path);
  }

  async getCurrentFilePath() {
    return this.filesPath;
  }

  async getFileTree(directoryPath = this.filesPath) {
    try {
      const stats = fs.statSync(directoryPath);
      const name = path.basename(directoryPath);

      const item = {
        name: name,
        type: stats.isDirectory() ? "folder" : path.extname(name).substring(1),
      };
      if (stats.isDirectory()) {
        item.children = fs
          .readdirSync(directoryPath)
          .map((child) => this.getFileTree(path.join(directoryPath, child)));
      }

      return item;
    } catch (error) {
      console.error(`Error getting file tree: ${error.message}`);
      throw error;
    }
  }

  async getFileStats(fileName) {
    try {
      const filePath = path.join(this.filesPath, fileName);
      return fs.statSync(filePath);
    } catch (error) {
      console.error(`Error getting file stats: ${error.message}`);
      throw error;
    }
  }

  async listFiles(directoryPath = this.filesPath) {
    try {
      return fs.readdirSync(directoryPath);
    } catch (error) {
      console.error(`Error listing files: ${error.message}`);
      throw error;
    }
  }

  async searchFiles(pattern, directoryPath = this.filesPath) {
    try {
      const files = await this.listFiles(directoryPath);
      return files.filter((file) => file.match(new RegExp(pattern)));
    } catch (error) {
      console.error(`Error searching files: ${error.message}`);
      throw error;
    }
  }

  async ensureDir() {
    if (!fs.existsSync(this.filesPath)) {
      fs.mkdirSync(this.filesPath, { recursive: true });
      console.log("Created workspace files directory:", this.filesPath);
    }
  }

  async saveFile(fileName, content) {
    try {
      const filePath = path.join(this.filesPath, fileName);
      fs.writeFileSync(filePath, content, "utf8");
      console.log(`File ${fileName} saved in workspace.`);
    } catch (error) {
      console.error(`Error saving file: ${error.message}`);
      throw error;
    }
  }

  async deleteFile(fileName) {
    try {
      const filePath = path.join(this.filesPath, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`File ${fileName} deleted from workspace.`);
      } else {
        throw new Error(`File ${fileName} not found.`);
      }
    } catch (error) {
      console.error(`Error deleting file: ${error.message}`);
      throw error;
    }
  }

  async loadFile(fileName) {
    try {
      const filePath = path.join(this.filesPath, fileName);
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `File ${fileName} not found in workspace with path ${filePath}`
        );
      }
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      console.error(`Error loading file: ${error.message}`);
      throw error;
    }
  }

  async copyFile(sourceFileName, destinationFileName) {
    try {
      const sourcePath = path.join(this.filesPath, sourceFileName);
      const destinationPath = path.join(this.filesPath, destinationFileName);
      fs.copyFileSync(sourcePath, destinationPath);
      console.log(`File ${sourceFileName} copied to ${destinationFileName}.`);
    } catch (error) {
      console.error(`Error copying file: ${error.message}`);
      throw error;
    }
  }

  async moveFile(sourceFileName, destinationFileName) {
    try {
      const sourcePath = path.join(this.filesPath, sourceFileName);
      const destinationPath = path.join(this.filesPath, destinationFileName);
      fs.renameSync(sourcePath, destinationPath);
      console.log(`File ${sourceFileName} moved to ${destinationFileName}.`);
    } catch (error) {
      console.error(`Error moving file: ${error.message}`);
      throw error;
    }
  }
}

const fileManager = new FileManager();
module.exports = fileManager;
