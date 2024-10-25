const express = require("express");
const nodes_router = express.Router();


nodes_router.use(express.json());

nodes_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200});
});


module.exports = nodes_router;
