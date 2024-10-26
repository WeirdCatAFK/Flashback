const express = require("express");
const tags_router = express.Router();
const db = require("./../config/dbmanager");


tags_router.use(express.json());

tags_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200});
});


module.exports = tags_router;
