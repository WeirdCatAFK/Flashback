const express = require("express");
const fs = require("fs");
const path = require("path");
const config_manager = express.Router();

const initConfigPath = path.join(__dirname, "../config/init/init_config.json");
const configPath = path.join(__dirname, "../data/config.json");

let config;
if (fs.existsSync(configPath)) {
  try {
    config = require(configPath);
  } catch (error) {
    console.log("Error loading config.json:", error);
    config = require(initConfigPath);
    fs.promises
      .writeFile(configPath, JSON.stringify(config, null, 2))
      .then(() => console.log("Config file restored from init_config"))
      .catch((err) => console.error("Error writing config file:", err));
  }
} else {
  console.log("Config file not found, loading default config.");
  const initConfig = require(initConfigPath);
  config = initConfig;

  fs.promises
    .writeFile(configPath, JSON.stringify(initConfig, null, 2))
    .then(() => console.log("Config file created from init_config"))
    .catch((err) => console.error("Error creating config file:", err));
}

config_manager.use(express.json());

//Get the config json
config_manager.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200, message: config });
});

// Create a new workspace
config_manager.post("/workspaces", async (req, res) => {
  const { name, description, path, db } = req.body;
  const newId =
    config.config.workspaces.length > 0
      ? Math.max(config.config.workspaces.map((ws) => ws.id)) + 1
      : 0;

  const newWorkspace = { id: newId, name, description, path, db };
  config.config.workspaces.push(newWorkspace);

  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
  res.status(201).json(newWorkspace);
});

// Change the current workspace
config_manager.put("/workspaces/current", async (req, res) => {
  const { workspace_id } = req.body;
  const workspaceExists = config.config.workspaces.some(
    (ws) => ws.id === workspace_id
  );

  if (!workspaceExists) {
    return res.status(404).json({ message: "Workspace not found" });
  }

  config.config.current.workspace_id = workspace_id;

  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
  res.status(200).json({ current: config.config.current });
});

// Rename a workspace
config_manager.put("/workspaces/:id/name", async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { new_name } = req.body;
  const workspace = config.config.workspaces.find(
    (ws) => ws.id === workspaceId
  );

  if (!workspace) {
    return res.status(404).json({ message: "Workspace not found" });
  }

  workspace.name = new_name;

  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
  res.status(200).json(workspace);
});

// Get current workspace
config_manager.get("/workspaces/current", (req, res) => {
  const currentWorkspace = config.config.workspaces.find(
    (ws) => ws.id === config.config.current.workspace_id
  );
  res.status(200).json(currentWorkspace);
});

// Get all workspaces
config_manager.get("/workspaces", (req, res) => {
  res.status(200).json(config.config.workspaces);
});

// Get workspace by ID
config_manager.get("/workspaces/:id", (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const workspace = config.config.workspaces.find(
    (ws) => ws.id === workspaceId
  );

  if (!workspace) {
    return res.status(404).json({ message: "Workspace not found" });
  }

  res.status(200).json(workspace);
});

module.exports = config_manager;
