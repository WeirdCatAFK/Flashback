import express from "express";
import ConfigManager from "../config/ConfigManager.js";
import workspaces_router from "./workspaces.js";

const config_router = express.Router();
//Get the config json
config_router.get("/", (req, res, next) => {
  return res.status(200).json({ code: 200, message: ConfigManager.config });
});

//Update the config
config_router.put("/", async (req, res, next) => {
  const { newConfig } = req.body;
  try {
    ConfigManager.config = newConfig;
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
    ConfigManager.config = initConfig;
    res.status(200).json({ code: 200, message: "Config reset to default" });
  } catch (error) {
    res.status(500).json({ code: 500, message: "Error resetting config" });
  }
});

//Manage workspaces
config_router.use("/workspaces", workspaces_router);

export default config_router;
