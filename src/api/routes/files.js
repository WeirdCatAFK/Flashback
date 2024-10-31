import express from "express";
import fileManager from "../config/filemanager.js";

const files_router = express.Router();
files_router.use(express.json());

// Get file tree
files_router.get("/tree", async (req, res) => {
  try {
    const tree = await fileManager.getDatabaseFileTree();
    res.status(200).json({
      code: 200,
      tree: tree,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Search files and folders
files_router.get("/search", async (req, res) => {
  try {
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({
        code: 400,
        error: "Search term is required",
      });
    }
    const results = await fileManager.searchDatabase(term);
    res.status(200).json({
      code: 200,
      results: results,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Read file
files_router.get("/:path(*)", async (req, res) => {
  try {
    const filePath = req.params.path;
    const { content, extension } = await fileManager.readFile(filePath);
    res.status(200).json({
      code: 200,
      content: content,
      extension: extension,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Create file
files_router.post("/:path(*)", async (req, res) => {
  try {
    const filePath = req.params.path;
    const { content } = req.body;
    if (content === undefined) {
      return res.status(400).json({
        code: 400,
        error: "Content is required",
      });
    }
    const result = await fileManager.createFile(filePath, content);
    res.status(201).json({
      code: 201,
      file: result,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Write to file
files_router.put("/:path(*)", async (req, res) => {
  try {
    const filePath = req.params.path;
    const { content } = req.body;
    if (content === undefined) {
      return res.status(400).json({
        code: 400,
        error: "Content is required",
      });
    }
    await fileManager.writeFile(filePath, content);
    res.status(200).json({
      code: 200,
      message: "File updated successfully",
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Change file extension
files_router.patch("/:path(*)/extension", async (req, res) => {
  try {
    const filePath = req.params.path;
    const { newExtension } = req.body;
    if (!newExtension) {
      return res.status(400).json({
        code: 400,
        error: "New extension is required",
      });
    }
    const result = await fileManager.changeFileExtension(
      filePath,
      newExtension
    );
    res.status(200).json({
      code: 200,
      file: result,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Move file
files_router.post("/:path(*)/move", async (req, res) => {
  try {
    const sourcePath = req.params.path;
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({
        code: 400,
        error: "Destination path is required",
      });
    }
    await fileManager.movePath(sourcePath, destination);
    res.status(200).json({
      code: 200,
      message: "File moved successfully",
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Rename File
files_router.put("/:path(*)/rename", async (req, res) => {
  try {
    const sourcePath = req.params.path;
    const { newName } = req.body;
    if (!newName) {
      return res.status(400).json({
        code: 400,
        error: "newName is required",
      });
    }
    await fileManager.renameFile(sourcePath, newName);
    res.status(200).json({
      code: 200,
      message: "File moved successfully",
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Delete file
files_router.delete("/:path(*)", async (req, res) => {
  try {
    const filePath = req.params.path;
    await fileManager.deletePath(filePath);
    res.status(200).json({
      code: 200,
      message: "File deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Create folder
files_router.post("/folder/:path(*)", async (req, res) => {
  try {
    const folderPath = req.params.path;
    const result = await fileManager.createFolder(folderPath);
    res.status(201).json({
      code: 201,
      folder: result,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Move folder
files_router.post("/folder/:path(*)/move", async (req, res) => {
  try {
    const sourcePath = req.params.path;
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({
        code: 400,
        error: "Destination path is required",
      });
    }
    await fileManager.movePath(sourcePath, destination);
    res.status(200).json({
      code: 200,
      message: "Folder moved successfully",
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

export default files_router;
