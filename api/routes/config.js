const express = require("express");
const fs = require("fs");
const path = require("path");
const config_router = express.Router();
const workspaces_router = require("./workspaces");

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

config_router.use(express.json());
//Get the config json
config_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200, message: config });
});

//Manage workspaces
config_router.use("/workspaces", workspaces_router);

module.exports = config_router;

