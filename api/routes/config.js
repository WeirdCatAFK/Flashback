const express = require("express");
const config_router = express.Router();
const workspaces_router = require("./config/workspaces");


config_router.use(express.json());
//Get the config json
config_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200, message: config });
});


//Manage workspaces
config_router.use("/workspaces", workspaces_router);

module.exports = config_router;
