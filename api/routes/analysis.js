const express = require("express");
const analysis_router = express.Router();
const db = require("./../config/dbmanager");


analysis_router.use(express.json());

analysis_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200});
});


module.exports = analysis_router;
