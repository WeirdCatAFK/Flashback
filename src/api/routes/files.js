import express from "express";
import fileManager from "../config/filemanager.js";
import db from "../config/dbmanager.js";

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
files_router.get("/:id([0-9]{1,3})", async (req, res) => {
  try {
    const file_id = req.params.id;
    const filepath = await db.get(
      `SELECT filepath FROM Documents WHERE id = ?`,
      [file_id]
    );
    const file_extension = await db.get(
      `SELECT file_extension FROM Documents WHERE id = ?`,
      [file_id]
    );

    const { content, extension } = await fileManager.readFile(
      filepath.filepath
    );
    res.status(200).json({
      code: 200,
      extension: extension,
      content: content,
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Rename File
files_router.put("/:id([0-9]{1,3})/rename", async (req, res) => {
  const file_id = req.params.id;
  const new_name = req.body.rename;
  const rows = await db.get(`SELECT filepath FROM Documents WHERE id = ?`, [
    file_id,
  ]);
  const filepath = rows?.filepath;

  if (!filepath) {
    return res.status(404).json({ code: 404, error: "File not found" });
  }

  try {
    await fileManager.renameFile(filepath, new_name);
    res.status(200).json({ code: 200, message: "File renamed successfully" });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});

// Rename Folder
files_router.put("/folder/:id([0-9]{1,3})/rename", async (req, res) => {
  const file_id = req.params.id;
  const new_name = req.body.rename;
  const rows = await db.get(`SELECT filepath FROM Folders WHERE id = ?`, [
    file_id,
  ]);
  const filepath = rows?.filepath;

  if (!filepath) {
    return res.status(404).json({ code: 404, error: "Folder not found" });
  }

  try {
    await fileManager.renameFolder(filepath, new_name);
    res.status(200).json({ code: 200, message: "Folder renamed successfully" });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});

//Get Absolute FilePath given it's id
//For a File
files_router.get("/:id([0-9]{1,3})/path", async (req, res) => {
  try {
    const file_id = req.params.id;
    const rows = await db.get(`SELECT filepath FROM Documents WHERE id = ?`, [
      file_id,
    ]);
    const filepath = rows?.filepath;
    res.status.json({ code: 200, message: filepath });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});

//Get Absolute FilePath given it's id
//For a Folder
files_router.get("folder/:id([0-9]{1,3})/path", async (req, res) => {
  const file_id = req.params.id;
  const rows = await db.get(`SELECT filepath FROM Folders WHERE id = ?`, [
    file_id,
  ]);
  const filepath = rows?.filepath;
});

//Get Relative FilePath given it's id
//For a File
files_router.get("/:id([0-9]{1,3})/path", async (req, res) => {
  try {
    const wrkspce_root = fileManager.getCurrentFilePath();
    const file_id = req.params.id;
    const rows = await db.get(`SELECT filepath FROM Documents WHERE id = ?`, [
      file_id,
    ]);
    const filepath = rows?.filepath; //This is also absolute
    const relative_path = path.relative(wrkspce_root, filepath);
    res.status(200).json({ code: 200, message: relative_path });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});

//Get Relative FilePath given it's id
//For a Folder
files_router.get("folder/:id([0-9]{1,3})/path", async (req, res) => {
  try {
    const wrkspce_root = fileManager.getCurrentFilePath();
    const file_id = req.params.id;
    const rows = await db.get(`SELECT filepath FROM Folders WHERE id = ?`, [
      file_id,
    ]);
    const filepath = rows?.filepath; //This is also absolute
    const relative_path = path.relative(wrkspce_root, filepath);
    res.status(200).json({ code: 200, message: relative_path });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});

// Move file
files_router.post(
  "/:id([0-9]{1,3})/move/:folder_id([0-9]{1,3})",
  async (req, res) => {
    try {
      const wrkspce_root = fileManager.getCurrentFilePath();
      const file_id = req.params.id;

      // Retrieve the file's current path
      let rows = await db.get(`SELECT filepath FROM Documents WHERE id = ?`, [
        file_id,
      ]);
      const filepath = rows?.filepath;

      if (!filepath) {
        return res.status(404).json({
          code: 404,
          error: "File not found",
        });
      }

      const folder_id = req.params.folder_id;

      // Retrieve the target folder's path
      rows = await db.get(`SELECT filepath FROM Folders WHERE id = ?`, [
        folder_id,
      ]);
      const folderPath = rows?.filepath;

      if (!folderPath) {
        return res.status(404).json({
          code: 404,
          error: "Target folder not found",
        });
      }

      // Retrieve the file's name
      rows = await db.get(`SELECT name FROM Documents WHERE id = ?`, [file_id]);
      const filename = rows?.name;

      if (!filename) {
        return res.status(404).json({
          code: 404,
          error: "File name not found",
        });
      }

      // Calculate relative paths
      const sourceRelativePath = path.relative(wrkspce_root, filepath);
      const destinationRelativePath = path.join(
        path.relative(wrkspce_root, folderPath),
        filename
      );

      // Check if destination path is valid
      if (!destinationRelativePath) {
        return res.status(400).json({
          code: 400,
          error: "Invalid destination path",
        });
      }

      // Perform the move operation
      await fileManager.movePath(sourceRelativePath, destinationRelativePath);

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
  }
);

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
    await fileManager.moveFile(sourcePath, destination);
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
