const express = require("express");
const fs = require("fs");
const path = require("path");
const workspaces_router = express.Router();

const initConfigPath = path.join(__dirname, "./../../config/init/init_config.json");
const configPath = path.join(__dirname, "./../../data/config.json");


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

// Workspace Retrieval and info

// Get all workspaces
workspaces_router.get("/", (req, res) => {
  res.status(200).json(config.config.workspaces);
});

// Get current workspace
workspaces_router.get("/current", (req, res) => {
  const currentWorkspace = config.config.workspaces.find(
    (ws) => ws.id === config.config.current.workspace_id
  );
  res.status(200).json(currentWorkspace);
});

// Get workspace by ID
workspaces_router.get("/:id", (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const workspace = config.config.workspaces.find(
    (ws) => ws.id === workspaceId
  );

  if (!workspace) {
    return res.status(404).json({ message: "Workspace not found" });
  }

  res.status(200).json(workspace);
});

// Workspace Creation and Management

// Create a new workspace
workspaces_router.post("/", async (req, res) => {
  let { name, description, path, db } = req.body;
  name = decodeURIComponent(name).trim();
  description = decodeURIComponent(description).trim();
  path = decodeURIComponent(path).trim();
  db = decodeURIComponent(path).trim();

  if (name && description && path && db) {
    const newId =
      config.config.workspaces.length > 0
        ? Math.max(...config.config.workspaces.map((ws) => ws.id)) + 1
        : 0;

    const newWorkspace = { id: newId, name, description, path, db };
    config.config.workspaces.push(newWorkspace);

    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    res.status(201).json({ code: 200, message: newWorkspace });
  } else {
    res.status(400).json({ code: 400, message: "Missing required fields" });
  }
});

// Change the current workspace
workspaces_router.put("/current", async (req, res) => {
  let { workspace_id } = req.body;
  workspace_id = Number(workspace_id);
  if (isNaN(workspace_id)) {
    return res.status(400).json({
      code: 400,
      message: "Invalid workspace_id: must be a valid number.",
    });
  }

  console.log(`Workspace ${workspace_id}`);
  const workspaceExists = config.config.workspaces.some(
    (ws) => ws.id === workspace_id
  );

  if (!workspaceExists) {
    return res.status(404).json({
      code: 404,
      message: "Workspace not found",
    });
  }
  config.config.current.workspace_id = workspace_id;
  try {
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    res.status(200).json({
      code: 200,
      message: `Current workspace set to ${workspace_id}`,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: "Error saving the updated configuration.",
    });
  }
});

// Rename a workspace
workspaces_router.put("/:id/name", async (req, res) => {
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

//Workspace Deletion

// Delete a workspace
workspaces_router.delete("/:id", async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const workspaceIndex = config.config.workspaces.findIndex(
    (ws) => ws.id === workspaceId
  );

  if (workspaceIndex === -1) {
    return res.status(404).json({ code: 404, message: "Workspace not found" });
  }
  config.config.workspaces.splice(workspaceIndex, 1);
  config.config.workspaces = config.config.workspaces.map((ws, index) => ({
    ...ws,
    id: index,
  }));
  try {
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    res.status(200).json({
      code: 200,
      message: `Workspace ${workspaceId} deleted and IDs reassigned`,
    });
  } catch (error) {
    res
      .status(500)
      .json({ code: 500, message: "Error updating the configuration file" });
  }
});

module.exports = workspaces_router;
