const express = require("express");
const flashcards_router = express.Router();
const db = require("./../config/dbmanager");


flashcards_router.use(express.json());

flashcards_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200});
});


module.exports = flashcards_router;
