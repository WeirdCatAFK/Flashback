import express from "express";
import multer from "multer";
import fileManager from "../config/filemanager.js";
import db from "../config/dbmanager.js";
import path from "path";
import fs from "fs";

const upload_router = express.Router();
const upload = multer();

async function createFolderInDb(folderName, folderPath, parentFolderId) {
  const existingFolder = await db.get(
    "SELECT id, node_id FROM Folders WHERE filepath = ?",
    [folderPath]
  );

  if (existingFolder) {
    return existingFolder;
  }

  await db.run(
    'INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = "Folder"), 0.0)'
  );

  const nodeResult = await db.get("SELECT last_insert_rowid() as lastID");
  const nodeId = nodeResult.lastID;

  await db.run(
    "INSERT INTO Folders (name, filepath, node_id, parent_folder_id) VALUES (?, ?, ?, ?)",
    [folderName, folderPath, nodeId, parentFolderId || null]
  );

  const folderResult = await db.get("SELECT last_insert_rowid() as lastID");

  // Insert a node connection if there is a parent folder
  if (parentFolderId) {
    const parentNodeId = await db.get(
      "SELECT node_id FROM Folders WHERE id = ?",
      [parentFolderId]
    );
    await db.run(
      "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, ?)",
      [parentNodeId.node_id, nodeId, 1] // Default connection type
    );
  }

  return {
    id: folderResult.lastID,
    node_id: nodeId,
  };
}

upload_router.post("/", upload.single("file"), async (req, res) => {
  let transaction = false;
  try {
    const workspacePath = await fileManager.getCurrentFilePath();
    const relativePath = req.body.relativePath || "";

    await db.run("BEGIN TRANSACTION");
    transaction = true;

    const parentFolderId = await ensureCompleteFolderPath(
      workspacePath,
      relativePath
    );

    if (!req.file) {
      await db.run("ROLLBACK");
      return res.status(400).json({ code: 400, message: "No file uploaded" });
    }

    const resolvedPath = parentFolderId
      ? path.join(workspacePath, normalizeFilePath(relativePath).join(path.sep))
      : workspacePath;

    const filename = getUniqueFilename(resolvedPath, req.file.originalname);
    const filePath = path.join(resolvedPath, filename);
    const fileExtension = path.extname(filename).toLowerCase().slice(1);

    // Create node for document
    await db.run(
      'INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = "Document"), 0.0)'
    );

    const nodeResult = await db.get("SELECT last_insert_rowid() as lastID");
    const nodeId = nodeResult.lastID;

    // Insert the document
    await db.run(
      "INSERT INTO Documents (folder_id, name, filepath, file_extension, node_id) VALUES (?, ?, ?, ?, ?)",
      [parentFolderId || null, filename, filePath, fileExtension, nodeId]
    );

    // Insert the node connection between folder and document
    if (parentFolderId) {
      const parentNodeId = await db.get(
        "SELECT node_id FROM Folders WHERE id = ?",
        [parentFolderId]
      );
      await db.run(
        "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, ?)",
        [parentNodeId.node_id, nodeId, 1]
      );
    }

    // Write file to disk
    await fs.promises.writeFile(filePath, req.file.buffer);

    await db.run("COMMIT");
    transaction = false;

    res.json({
      code: 200,
      message: "File uploaded successfully",
      file: {
        originalname: req.file.originalname,
        filename: filename,
        path: filePath,
        size: req.file.size,
        nodeId: nodeId,
        parentFolderId: parentFolderId,
      },
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    console.error("Upload error:", error);
    res.status(500).json({
      code: 500,
      message: "Error handling file upload",
      error: error.message,
    });
  }
});

function normalizeFilePath(inputPath) {
  // Remove any duplicate slashes and normalize to forward slashes
  let normalized = inputPath.replace(/\/+/g, "/").replace(/\\/g, "/");

  // Remove leading and trailing slashes
  normalized = normalized.replace(/^\/+|\/+$/g, "");

  // Filter out empty segments and dangerous patterns
  const validSegments = normalized.split("/").filter((segment) => {
    // Remove empty segments and common dangerous patterns
    return (
      segment &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes(":") && // Prevents "C:" style paths
      !/^[A-Za-z]:/.test(segment) && // Prevents "C:" at start of segment
      !/^CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]$/i.test(segment)
    ); // Windows reserved names
  });

  return validSegments;
}

async function ensureCompleteFolderPath(workspacePath, relativePath) {
  // Normalize and validate the workspace path
  const normalizedWorkspace = path.normalize(workspacePath);

  // Get path components, excluding problematic parts
  const pathComponents = normalizeFilePath(relativePath);

  if (pathComponents.length === 0) {
    // If no valid path components, return null to use workspace root
    return null;
  }

  let currentPath = normalizedWorkspace;
  let parentFolderId = null;

  // Create each folder in the path hierarchy, updating parent_folder_id
  for (const folder of pathComponents) {
    try {
      currentPath = path.join(currentPath, folder);

      // Verify the path is still within workspace
      const relative = path.relative(normalizedWorkspace, currentPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Path traversal detected");
      }

      // Create folder in the filesystem if it doesn't exist
      if (!fs.existsSync(currentPath)) {
        fs.mkdirSync(currentPath, { recursive: true });
      }

      // Create or get folder in the database with reference to parent_folder_id
      const folderResult = await createFolderInDb(
        folder,
        currentPath,
        parentFolderId
      );
      parentFolderId = folderResult.id; // Update parent_folder_id for next iteration
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        throw new Error(`Permission denied creating folder: ${folder}`);
      } else if (error.code === "ENOENT") {
        throw new Error(`Invalid path component: ${folder}`);
      }
      throw error;
    }
  }

  return parentFolderId;
}

upload_router.post("/", upload.single("file"), async (req, res) => {
  let transaction = false;
  try {
    const workspacePath = await fileManager.getCurrentFilePath();
    const relativePath = req.body.relativePath || "";

    // Start transaction before any database operations
    await db.run("BEGIN TRANSACTION");
    transaction = true;

    // Ensure complete folder structure exists and get final parent folder ID
    const parentFolderId = await ensureCompleteFolderPath(
      workspacePath,
      relativePath
    );

    if (!req.file) {
      await db.run("ROLLBACK");
      return res.status(400).json({ code: 400, message: "No file uploaded" });
    }

    // Final path
    const resolvedPath = parentFolderId
      ? path.join(workspacePath, normalizeFilePath(relativePath).join(path.sep))
      : workspacePath;

    // Get unique filename
    const filename = getUniqueFilename(resolvedPath, req.file.originalname);
    const filePath = path.join(resolvedPath, filename);
    const fileExtension = path.extname(filename).toLowerCase().slice(1);

    // Create node for document
    await db.run(
      'INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = "Document"), 0.0)'
    );

    // Get the last inserted node ID
    const nodeResult = await db.get("SELECT last_insert_rowid() as lastID");
    const nodeId = nodeResult.lastID;

    // Create document entry
    await db.run(
      "INSERT INTO Documents (folder_id, name, filepath, file_extension, node_id) VALUES (?, ?, ?, ?, ?)",
      [parentFolderId || null, filename, filePath, fileExtension, nodeId]
    );

    // Write file to disk
    await fs.promises.writeFile(filePath, req.file.buffer);

    // Commit transaction
    await db.run("COMMIT");
    transaction = false;

    res.json({
      code: 200,
      message: "File uploaded successfully",
      file: {
        originalname: req.file.originalname,
        filename: filename,
        path: filePath,
        size: req.file.size,
        nodeId: nodeId,
        parentFolderId: parentFolderId,
      },
    });
  } catch (error) {
    if (transaction) {
      await db.run("ROLLBACK");
    }
    console.error("Upload error:", error);
    res.status(500).json({
      code: 500,
      message: "Error handling file upload",
      error: error.message,
    });
  }
});

function getUniqueFilename(directory, originalFilename) {
  // Replace spaces with underscores in the original filename
  let filename = originalFilename.replace(/\s+/g, "_");

  let counter = 1;
  // Ensure the filename is unique by checking if it already exists in the directory
  while (fs.existsSync(path.join(directory, filename))) {
    const parsedFilename = path.parse(originalFilename);
    filename = `${parsedFilename.name.replace(/\s+/g, "_")}_${counter}${
      parsedFilename.ext
    }`;
    counter++;
  }

  return filename;
}

export default upload_router;
