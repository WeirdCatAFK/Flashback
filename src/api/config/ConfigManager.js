import fs from "fs";
import path from "path";

import { app } from "electron";
const userDataPath = app.getPath("userData");

class ConfigManager {
  constructor() {
    this.configPath = path.join(userDataPath, "data", "config.json");
    this.loadConfig();
  }

  loadConfig() {
    try {
      this._config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    } catch (error) {
      console.error("Error loading config file:", error);
      this._config = { config: { current: {}, workspaces: [] } };
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this._config, null, 2));
    } catch (error) {
      console.error("Error saving config file:", error);
    }
  }

  get config() {
    return this._config;
  }

  set config(newConfig) {
    this._config = newConfig;
    this.saveConfig();
  }

  get current_config() {
    return this._config.config.current;
  }

  set current_workspace(workspaceId) {
    this._config.config.current.workspace_id = workspaceId;
    this.saveConfig();
  }

  get current_workspace() {
    return this._config.config.workspaces.find(
      (workspace) => workspace.id === this._config.config.current.workspace_id
    );
  }

  addWorkspace(workspace) {
    this._config.config.workspaces.push(workspace);
    this.saveConfig();
  }

  updateWorkspace(workspaceId, updates) {
    const workspace = this._config.config.workspaces.find(
      (ws) => ws.id === workspaceId
    );
    if (workspace) {
      Object.assign(workspace, updates);
      this.saveConfig();
    } else {
      throw new Error(`Workspace with ID ${workspaceId} not found`);
    }
  }
}

export default new ConfigManager();
