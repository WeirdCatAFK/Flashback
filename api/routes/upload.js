const express = require("express");
const multer = require("multer");
const fileManager = require("./../config/fileManager");
const path = require("path");
const fs = require("fs");

const upload_router = express.Router();

const upload = multer();

upload_router.post("/", upload.single("file"), async (req, res) => {
  try {
    const workspacePath = await fileManager.getCurrentFilePath();
    const relativePath = req.body.relativePath || "";
    const resolvedPath = path.resolve(workspacePath, relativePath);

    // Security check to ensure the path is within the workspace
    if (!path.relative(workspacePath, resolvedPath).startsWith('..')) {
      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }

      if (!req.file) {
        return res.status(400).json({ code: 400, message: "No file uploaded" });
      }

      const filename = getUniqueFilename(resolvedPath, req.file.originalname);
      const filePath = path.join(resolvedPath, filename);

      fs.writeFile(filePath, req.file.buffer, (err) => {
        if (err) {
          return res.status(500).json({ code: 500, message: "Error saving file", error: err.message });
        }

        res.json({
          code: 200,
          message: "File uploaded successfully",
          file: {
            originalname: req.file.originalname,
            filename: filename,
            path: filePath,
            size: req.file.size
          }
        });
      });
    } else {
      res.status(400).json({ code: 400, message: "Invalid path" });
    }
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: "Error handling file upload",
      error: error.message,
    });
  }
});

function getUniqueFilename(directory, originalFilename) {
  let filename = originalFilename;
  let counter = 1;
  while (fs.existsSync(path.join(directory, filename))) {
    const parsedFilename = path.parse(originalFilename);
    filename = `${parsedFilename.name}_${counter}${parsedFilename.ext}`;
    counter++;
  }
  return filename;
}

module.exports = upload_router;