import express from "express";
import fileManager from "../config/filemanager.js";
import db from "../config/dbmanager.js";
import path from "path";

const files_router = express.Router();
files_router.use(express.json());

// More specific routes first
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
//Get folder path
files_router.get("/folder/:id([0-9]{1,3})/path", async (req, res) => {
  try {
    const wrkspce_root = await fileManager.getCurrentFilePath();
    const folder_id = req.params.id;
    const rows = await db.get(`SELECT filepath FROM Folders WHERE id = ?`, [
      folder_id,
    ]);
    const filepath = rows?.filepath; //This is also absolute
    const relative_path = path.relative(wrkspce_root, filepath);
    res.status(200).json({ code: 200, message: relative_path });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});
//Get file path
files_router.get("/:id([0-9]{1,3})/path", async (req, res) => {
  try {
    const wrkspce_root = await fileManager.getCurrentFilePath();
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

//Get folder name
files_router.get("/folder/:id([0-9]{1,3})/name", async (req, res) => {
  try {
    const folder_id = req.params.id;
    const rows = await db.get(`SELECT name FROM Folders WHERE id = ?`, [
      folder_id,
    ]);
    const name = rows?.name;
    res.status(200).json({ code: 200, name: name });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
  }
});
//Get file name
files_router.get("/:id([0-9]{1,3})/name", async (req, res) => {
  try {
    const file_id = req.params.id;
    const rows = await db.get(`SELECT name FROM Documents WHERE id = ?`, [
      file_id,
    ]);
    const name = rows?.name;
    res.status(200).json({ code: 200, name: name });
  } catch (error) {
    res.status(500).json({ code: 500, error: error.message });
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

// Write File
files_router.put("/:id([0-9]{1,3})/write", async (req, res) => {
  try {
    const file_id = req.params.id;
    const content = req.body.content;
    const rows = await db.get(`SELECT filepath FROM Documents WHERE id = ?`, [
      file_id,
    ]);

    await fileManager.writeFile(rows.filepath, content);
    res.status(200).json({
      code: 200,
      message: "File writed succesfully",
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
  const origin_id = req.params.id;
  const new_name = req.body.rename;
  const rows = await db.get(`SELECT filepath FROM Folders WHERE id = ?`, [
    origin_id,
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

// Move routes
// Move file to another folder
files_router.post(
  "/:id([0-9]{1,3})/move/:folder_id(|[0-9]{1,3})",
  async (req, res) => {
    try {
      const wrkspce_root = await fileManager.getCurrentFilePath();
      const file_id = req.params.id;
      const folder_id = req.params.folder_id;
      const isRootMove = folder_id === "0";

      // Retrieve the file's current path
      const fileRow = await db.get(
        `SELECT filepath FROM Documents WHERE id = ?`,
        [file_id]
      );
      const filepath = fileRow?.filepath;

      if (!filepath) {
        return res.status(404).json({
          code: 404,
          error: "File not found",
        });
      }

      // Retrieve the file's name
      const nameRow = await db.get(`SELECT name FROM Documents WHERE id = ?`, [
        file_id,
      ]);
      const filename = nameRow?.name;

      if (!filename) {
        return res.status(404).json({
          code: 404,
          error: "File name not found",
        });
      }

      // Handle root folder case (0) and regular folders differently
      let folderPath;
      if (isRootMove) {
        folderPath = wrkspce_root;
      } else {
        // Retrieve the target folder's path
        const folderRow = await db.get(
          `SELECT filepath FROM Folders WHERE id = ?`,
          [folder_id]
        );

        if (!folderRow?.filepath) {
          return res.status(404).json({
            code: 404,
            error: "Target folder not found",
          });
        }
        folderPath = folderRow.filepath;
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

      // Perform the move operation with the root move flag
      await fileManager.moveFile(
        sourceRelativePath,
        destinationRelativePath,
        isRootMove
      );

      res.status(200).json({
        code: 200,
        message: "File moved successfully",
      });
    } catch (error) {
      console.log(error);
      res.status(500).json({
        code: 500,
        error: error.message,
      });
    }
  }
);

// Move folder to another folder
files_router.post(
  "/folder/:id([0-9]{1,3})/move/:folder_id(|[0-9]{1,3})",
  async (req, res) => {
    try {
      const source_folder_id = req.params.id;
      const target_folder_id = req.params.folder_id;
      await fileManager.moveFolder(source_folder_id, target_folder_id);
      res.status(200).json({
        code: 200,
        message: "Folder moved successfully",
      });
    } catch (error) {
      res.status(500).json({
        code: 500,
        message: "Failed to move Folder",
      });
    }
  }
);

// Create folder
files_router.post("/folder/:name(*)", async (req, res) => {
  try {
    const folder_name = req.params.name;
    const result = await fileManager.createFolder(folder_name);
    res.status(200).json({
      code: 200,
      folder: result,
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

// Delete folder
files_router.delete("/folder/:id([0-9]{1,3})", async (req, res) => {
  try {
    const folder_id = req.params.id;

    const folderRow = await db.get(
      `SELECT filepath FROM Folders WHERE id = ?`,
      [folder_id]
    );

    if (!folderRow?.filepath) {
      return res.status(404).json({
        code: 404,
        error: "Target folder not found",
      });
    }
    const folderPath = folderRow.filepath;
    await fileManager.deleteFolder(folderPath);
    res.status(200).json({
      code: 200,
      message: "Folder deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      error: error.message,
    });
  }
});

// Delete file
files_router.delete("/:id([0-9]{1,3})", async (req, res) => {
  try {
    const file_id = req.params.id;

    const folderRow = await db.get(
      `SELECT filepath FROM Documents WHERE id = ?`,
      [file_id]
    );

    if (!folderRow?.filepath) {
      return res.status(404).json({
        code: 404,
        error: "Target folder not found",
      });
    }
    const filePath = folderRow.filepath;

    await fileManager.deleteFile(filePath);
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

export default files_router;
