import express from "express";
import ConfigManager from "../config/ConfigManager.js";
const workspaces_router = express.Router();

// Get all workspaces
workspaces_router.get("/", (req, res) => {
  res.status(200).json(ConfigManager.config.config.workspaces);
});

// Get current workspace
workspaces_router.get("/current", (req, res) => {
  const currentWorkspace = ConfigManager.current_workspace;
  res.status(200).json(currentWorkspace);
});

// Get workspace by ID
workspaces_router.get("/:id", (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const workspace = ConfigManager.config.config.workspaces.find(
    (ws) => ws.id === workspaceId
  );

  if (!workspace) {
    return res.status(404).json({ message: "Workspace not found" });
  }

  res.status(200).json(workspace);
});

// Create a new workspace
workspaces_router.post("/", async (req, res) => {
  let { name, description, path, db } = req.body;
  name = decodeURIComponent(name).trim();
  description = decodeURIComponent(description).trim();
  path = decodeURIComponent(path).trim();
  db = decodeURIComponent(path).trim();

  if (name && description && path && db) {
    const newWorkspace = {
      id: ConfigManager.config.config.workspaces.length,
      name,
      description,
      path,
      db,
    };
    ConfigManager.addWorkspace(newWorkspace);
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

  if (
    !ConfigManager.config.config.workspaces.some((ws) => ws.id === workspace_id)
  ) {
    return res.status(404).json({
      code: 404,
      message: "Workspace not found",
    });
  }
  ConfigManager.current_workspace = workspace_id;
  res.status(200).json({
    code: 200,
    message: `Current workspace set to ${workspace_id}`,
  });
});

// Rename a workspace
workspaces_router.put("/:id/name", async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { new_name } = req.body;
  ConfigManager.updateWorkspace(workspaceId, { name: new_name });
  const updatedWorkspace = ConfigManager.config.config.workspaces.find(
    (ws) => ws.id === workspaceId
  );
  res.status(200).json(updatedWorkspace);
});

// Delete a workspace
workspaces_router.delete("/:id", async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const workspaceIndex = ConfigManager.config.config.workspaces.findIndex(
    (ws) => ws.id === workspaceId
  );

  if (workspaceIndex === -1) {
    return res.status(404).json({ code: 404, message: "Workspace not found" });
  }

  ConfigManager.config.config.workspaces.splice(workspaceIndex, 1);
  ConfigManager.config.config.workspaces =
    ConfigManager.config.config.workspaces.map((ws, index) => ({
      ...ws,
      id: index,
    }));
  ConfigManager.saveConfig();

  res.status(200).json({
    code: 200,
    message: `Workspace ${workspaceId} deleted and IDs reassigned`,
  });
});

export default workspaces_router;
