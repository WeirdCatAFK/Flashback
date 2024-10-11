const express = require("express");
const db = require("./../config/dbmanager.js");
const fileManager = require("./../config/filemanager.js"); //File manager module that handles workspace level applications to ease path resolving
const file_router = express.Router();

file_router.get("/", async function (req, res, next) {
  try {
    fileTree = await fileManager.getFileTree();
  } catch (error) {
    return res.status(500).json({ code: 505, message: error });
  }
  return res.status(200).json({ code: 200, message: fileTree });
});
file_router.get("/search/:name([A-Za-z]+)", async function (req, res, next) {
    const fileName = decodeURI(req.params.name)
    console.log(fileName);
    try{
        results = fileManager.searchFiles(fileName)
        return res.status(200).json({code: 200, message: results});
    }catch(error) {
        return res.status(500).json({ code: 500, message: error });
    } 
})
module.exports = file_router;
