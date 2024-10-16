const express = require("express");
const multer = require("multer");
const fileManager = require("./../config/fileManager.js"); //File manager module that handles workspace level applications to ease path resolving
const path = require("path");
const fs = require("fs");

const upload_router = express.Router();

const configureMulter = (uploadPath) => {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // Ensure the directory exists
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    },
  });

  return multer({ storage });
};

upload_router.post("/", async (req, res) => {
  try {
    // Get the base path of the current workspace
    const workspacePath = await fileManager.getCurrentFilePath();

    const uploadSubDir = req.body.uploadSubDir || ""; // Optional subdirectory to upload files
    const resolvedPath = path.join(workspacePath, uploadSubDir);

    // Configure Multer with the resolved path
    const upload = configureMulter(resolvedPath).single("file");

    // Use Multer to handle the file upload
    upload(req, res, (err) => {
      if (err) {
        return res
          .status(500)
          .json({ message: "Error uploading file", error: err });
      }
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      res.json({
        message: "File uploaded successfully",
        file: req.file,
      });
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error handling file upload", error: error.message });
  }
});

module.exports = upload_router;
