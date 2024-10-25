const express = require("express");
const paths_router = express.Router();


paths_router.use(express.json());

paths_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200``});
});


module.exports = paths_router;
