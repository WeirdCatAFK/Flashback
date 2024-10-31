import express from "express";
import { ConfigManager } from "../config/configmanager.js";
import workspaces_router from "./config/workspaces.js";

const config_router = express.Router();
const configManager = new ConfigManager();
//Get the config json
config_router.get("/", (req, res, next) => {
  return res.status(200).json({ code: 200, message: configManager.config });
});

//Update the config
config_router.put("/", async (req, res, next) => {
  const { newConfig } = req.body;
  try {
    configManager.config = newConfig;
    res.status(200).json({ code: 200, message: "Config updated successfully" });
  } catch (error) {
    res.status(500).json({ code: 500, message: "Error updating config" });
  }
});

//Reset the config to default
config_router.post("/reset", async (req, res, next) => {
  try {
    const initConfig = JSON.parse(
      await fs.promises.readFile(initConfigPath, "utf8")
    );
    configManager.config = initConfig;
    res.status(200).json({ code: 200, message: "Config reset to default" });
  } catch (error) {
    res.status(500).json({ code: 500, message: "Error resetting config" });
  }
});

//Manage workspaces
config_router.use("/workspaces", workspaces_router);

export default config_router;
