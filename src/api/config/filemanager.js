import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "./dbmanager.js";
import { ConfigManager } from "./configmanager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FileManager {
  constructor() {
    this.configManager = new ConfigManager();
    const currentWorkspace = this.configManager.current_workspace;

    if (!currentWorkspace) {
      throw new Error("Current workspace not found in config.");
    }

    this.filePath = path.isAbsolute(currentWorkspace.path)
      ? currentWorkspace.path
      : path.resolve(__dirname, "../../", currentWorkspace.path);
  }
  static FILE_TYPES = {
    // Text files
    txt: { encoding: "utf8", binary: false },
    md: { encoding: "utf8", binary: false },
    json: { encoding: "utf8", binary: false },
    csv: { encoding: "utf8", binary: false },
    xml: { encoding: "utf8", binary: false },
    html: { encoding: "utf8", binary: false },
    css: { encoding: "utf8", binary: false },
    js: { encoding: "utf8", binary: false },
    ts: { encoding: "utf8", binary: false },

    // Binary files
    pdf: { binary: true },
    doc: { binary: true },
    docx: { binary: true },
    xls: { binary: true },
    xlsx: { binary: true },
    zip: { binary: true },
    rar: { binary: true },

    // Image files
    jpg: { binary: true },
    jpeg: { binary: true },
    png: { binary: true },
    gif: { binary: true },
    bmp: { binary: true },
    svg: { encoding: "utf8", binary: false }, // SVG is text-based XML

    // Audio/Video files
    mp3: { binary: true },
    wav: { binary: true },
    mp4: { binary: true },
    avi: { binary: true },

    // Default handling for unknown extensions
    default: { binary: true },
  };

  async getCurrentFilePath() {
    return this.filePath;
  }

  async createDatabaseNode(type, presence = 0.0) {
    await db.run(
      "INSERT INTO Nodes (type_id, presence) VALUES ((SELECT id FROM Node_types WHERE name = ?), ?)",
      [type, presence]
    );
    const result = await db.get("SELECT last_insert_rowid() as lastID");
    return result.lastID;
  }

  async createOrGetFolderEntry(name, absolutePath, parentFolderId = null) {
    const existingFolder = await db.get(
      "SELECT id, node_id FROM Folders WHERE filepath = ?",
      [absolutePath]
    );

    if (existingFolder) {
      return existingFolder;
    }

    const nodeId = await this.createDatabaseNode("Folder");

    await db.run(
      "INSERT INTO Folders (name, filepath, node_id, parent_folder_id) VALUES (?, ?, ?, ?)",
      [name, absolutePath, nodeId, parentFolderId]
    );

    const folderResult = await db.get("SELECT last_insert_rowid() as lastID");

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

    return {
      id: folderResult.lastID,
      node_id: nodeId,
    };
  }

  async initializeWorkspace() {
    let transaction = false;
    try {
      if (!fs.existsSync(this.filePath)) {
        await db.run("BEGIN TRANSACTION");
        transaction = true;

        fs.mkdirSync(this.filePath, { recursive: true });
        await this.createOrGetFolderEntry(
          path.basename(this.filePath),
          this.filePath
        );

        await db.run("COMMIT");
        transaction = false;
        console.log("Initialized workspace directory:", this.filePath);
      }
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }
  async getDatabaseFileTree() {
    const query = `
      WITH RECURSIVE
      folder_tree AS (
        -- Base case: root folders with their node data
        SELECT 
          f.id, 
          f.name, 
          f.filepath, 
          f.parent_folder_id,
          n.presence,
          1 as level,
          CAST(f.id AS TEXT) as path
        FROM Folders f
        JOIN Nodes n ON f.node_id = n.id
        WHERE f.parent_folder_id IS NULL
        
        UNION ALL
        
        -- Recursive case: child folders
        SELECT 
          f.id, 
          f.name, 
          f.filepath, 
          f.parent_folder_id,
          n.presence,
          ft.level + 1,
          ft.path || '/' || f.id
        FROM Folders f
        JOIN Nodes n ON f.node_id = n.id
        JOIN folder_tree ft ON f.parent_folder_id = ft.id
      ),
      documents_with_data AS (
        -- Pre-join documents with their node data
        SELECT 
          d.id,
          d.name,
          d.filepath,
          d.folder_id,
          d.file_extension,
          n.presence
        FROM Documents d
        JOIN Nodes n ON d.node_id = n.id
      )
      SELECT 
        ft.id as folder_id,
        ft.name as folder_name,
        ft.filepath as folder_path,
        ft.parent_folder_id,
        ft.presence as folder_presence,
        ft.level,
        ft.path as folder_tree_path,
        d.id as document_id,
        d.name as document_name,
        d.filepath as document_path,
        d.file_extension,
        d.presence as document_presence
      FROM folder_tree ft
      LEFT JOIN documents_with_data d ON d.folder_id = ft.id
      
      UNION ALL
      
      SELECT 
        NULL as folder_id,
        NULL as folder_name,
        NULL as folder_path,
        NULL as parent_folder_id,
        NULL as folder_presence,
        1 as level,
        '' as folder_tree_path,
        d.id as document_id,
        d.name as document_name,
        d.filepath as document_path,
        d.file_extension,
        d.presence as document_presence
      FROM documents_with_data d
      WHERE d.folder_id IS NULL
      ORDER BY folder_tree_path, document_name;
    `;

    try {
      const results = await db.all(query);
      return this.buildTreeFromResults(results);
    } catch (error) {
      console.error("Error fetching file tree:", error);
      throw new Error("Failed to fetch file tree from database");
    }
  }

  buildTreeFromResults(results) {
    const folderMap = new Map();
    const rootItems = [];
    const fileTypeCache = new Map();
    let keyCounter = 1; // Counter for generating unique keys

    const getFileType = (fileExtension) => {
      if (fileTypeCache.has(fileExtension)) {
        return fileTypeCache.get(fileExtension);
      }
      const fileType =
        FileManager.FILE_TYPES[fileExtension] || FileManager.FILE_TYPES.default;
      fileTypeCache.set(fileExtension, fileType);
      return fileType;
    };

    // Process folders first
    const processedFolders = new Set();

    for (const row of results) {
      if (row.folder_id && !processedFolders.has(row.folder_id)) {
        const folder = {
          key: keyCounter++, // Add unique key
          id: row.folder_id,
          name: row.folder_name,
          is_folder: true,
          presence: row.folder_presence,
          items: [],
        };

        folderMap.set(row.folder_id, folder);
        processedFolders.add(row.folder_id);

        if (row.parent_folder_id === null) {
          rootItems.push(folder);
        } else if (folderMap.has(row.parent_folder_id)) {
          folderMap.get(row.parent_folder_id).items.push(folder);
        }
      }
    }

    // Process documents
    for (const row of results) {
      if (row.document_id) {
        const fileType = getFileType(row.file_extension);

        const document = {
          key: keyCounter++, // Add unique key
          id: row.document_id,
          name: row.document_name,
          is_folder: false,
          presence: row.document_presence,
          file_extension: row.file_extension,
          encoding: fileType.binary ? 0 : 1,
          items: [],
        };

        if (row.folder_id && folderMap.has(row.folder_id)) {
          folderMap.get(row.folder_id).items.push(document);
        } else {
          rootItems.push(document);
        }
      }
    }

    // Create root with a key
    return {
      key: 0, // Root always has key 0
      id: 0,
      name: "root",
      is_folder: true,
      presence: 0,
      items: rootItems,
    };
  }

  async createFile(relativePath, content) {
    if (!content) {
      content = "";
    }
    let transaction = false;
    try {
      const absolutePath = path.join(this.filePath, relativePath);
      const dirPath = path.dirname(absolutePath);
      const fileName = path.basename(absolutePath);
      const fileExtension = path.extname(fileName).toLowerCase().slice(1);

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Ensure parent directory exists
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Only create a folder node if dirPath is different from this.filePath
      let parentFolder = null;
      if (dirPath !== this.filePath) {
        parentFolder = await this.createOrGetFolderEntry(
          path.basename(dirPath),
          dirPath
        );
      }

      // Create document node and entry
      const nodeId = await this.createDatabaseNode("Document");
      await db.run(
        "INSERT INTO Documents (folder_id, name, filepath, file_extension, node_id) VALUES (?, ?, ?, ?, ?)",
        [
          parentFolder ? parentFolder.id : null,
          fileName,
          absolutePath,
          fileExtension,
          nodeId,
        ]
      );

      // Create node connection if there's a parent folder
      if (parentFolder) {
        // Get the parent folder's node_id
        const parentNodeResult = await db.get(
          "SELECT node_id FROM Folders WHERE id = ?",
          [parentFolder.id]
        );

        if (parentNodeResult && parentNodeResult.node_id) {
          // Create connection from parent folder's node to document's node
          await db.run(
            "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, ?)",
            [parentNodeResult.node_id, nodeId, 1] // Using connection_type_id 1 (empty string type)
          );
        }
      }

      const documentResult = await db.get(
        "SELECT last_insert_rowid() as lastID"
      );

      await fs.promises.writeFile(absolutePath, content);

      await db.run("COMMIT");
      transaction = false;

      return {
        id: documentResult.lastID,
        node_id: nodeId,
      };
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }
  async deleteFile(absolutePath) {
    let transaction = false;
    try {
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`File ${absolutePath} not found.`);
      }

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      const stats = await fs.promises.stat(absolutePath);
      if (stats.isFile()) {
        await db.run("DELETE FROM Documents WHERE filepath = ?", [
          absolutePath,
        ]);
        await fs.promises.unlink(absolutePath);
      } else {
        throw new Error(`Path ${absolutePath} is not a file.`);
      }

      await db.run("COMMIT");
      transaction = false;
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  async deleteFolder(absolutePath) {
    let transaction = false;
    try {
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Folder ${absolutePath} not found.`);
      }
      console.log(absolutePath);
      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Check if the path is a directory
      const stats = await fs.promises.stat(absolutePath);
      if (stats.isDirectory()) {
        // Find the folder by filepath to get its ID and children
        const folder = await db.get(
          "SELECT id FROM Folders WHERE filepath = ?",
          [absolutePath]
        );
        if (!folder) {
          throw new Error(
            `Folder with path ${absolutePath} not found in the database.`
          );
        }

        // Get all child folders using LIKE for path matching
        const childFolders = await db.all(
          "SELECT id FROM Folders WHERE filepath LIKE ?",
          [absolutePath + "\\%"] // Match all subfolders with the same prefix
        );

        // Create array of all folder IDs including the current folder
        const allFolderIds = [folder.id, ...childFolders.map((f) => f.id)];

        // SQLite doesn't handle array parameters well, so we'll construct the IN clause safely
        const placeholders = allFolderIds.map(() => "?").join(",");

        // Delete documents in these folders
        // First, get all document IDs that will be deleted
        const documentsToDelete = await db.all(
          `SELECT id FROM Documents WHERE folder_id IN (${placeholders})`,
          allFolderIds
        );
        const documentIds = documentsToDelete.map((doc) => doc.id);

        if (documentIds.length > 0) {
          const docPlaceholders = documentIds.map(() => "?").join(",");

          // Delete flashcard media
          await db.run(
            `DELETE FROM Flashcard_media WHERE flashcard_id IN (
                        SELECT id FROM Flashcards WHERE document_id IN (${docPlaceholders})
                    )`,
            documentIds
          );

          // Delete flashcard info
          await db.run(
            `DELETE FROM Flashcard_info WHERE flashcard_id IN (
                        SELECT id FROM Flashcards WHERE document_id IN (${docPlaceholders})
                    )`,
            documentIds
          );

          // Delete flashcard highlights
          await db.run(
            `DELETE FROM Flashcard_highlight WHERE id IN (
                        SELECT highlight_id FROM Flashcards WHERE document_id IN (${docPlaceholders})
                    )`,
            documentIds
          );

          // Delete flashcards
          await db.run(
            `DELETE FROM Flashcards WHERE document_id IN (${docPlaceholders})`,
            documentIds
          );

          // Finally delete the documents
          await db.run(
            `DELETE FROM Documents WHERE id IN (${docPlaceholders})`,
            documentIds
          );
        }

        // Delete folder-related data
        // Delete inherited tags first (due to foreign key constraints)
        await db.run(
          `DELETE FROM Inherited_tags WHERE connection_id IN (
                    SELECT id FROM Node_connections WHERE origin_id IN (
                        SELECT node_id FROM Folders WHERE id IN (${placeholders})
                    )
                )`,
          allFolderIds
        );

        // Delete node connections
        await db.run(
          `DELETE FROM Node_connections WHERE origin_id IN (
                    SELECT node_id FROM Folders WHERE id IN (${placeholders})
                )`,
          allFolderIds
        );

        // Delete the folders
        await db.run(
          `DELETE FROM Folders WHERE id IN (${placeholders})`,
          allFolderIds
        );

        // Delete from filesystem
        await fs.promises.rm(absolutePath, { recursive: true });
      } else {
        throw new Error(`Path ${absolutePath} is not a folder.`);
      }

      await db.run("COMMIT");
      transaction = false;
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  async moveFile(sourceRelativePath, destRelativePath, isRootMove = false) {
    let transaction = false;
    try {
      const sourcePath = path.join(this.filePath, sourceRelativePath);
      const destPath = path.join(this.filePath, destRelativePath);
      const destDir = path.dirname(destPath);

      // Validate source exists
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source ${sourceRelativePath} not found.`);
      }

      // Check if destination already exists
      if (fs.existsSync(destPath)) {
        throw new Error(`Destination ${destRelativePath} already exists.`);
      }

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Ensure destination directory exists
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      let destFolder = null;
      if (!isRootMove) {
        destFolder = await this.createOrGetFolderEntry(
          path.basename(destDir),
          destDir
        );
      }

      const stats = await fs.promises.stat(sourcePath);
      if (stats.isDirectory()) {
        // Get the source folder's node_id and current parent folder
        const sourceFolder = await db.get(
          "SELECT f.node_id, f.parent_folder_id, pf.node_id as parent_node_id FROM Folders f LEFT JOIN Folders pf ON f.parent_folder_id = pf.id WHERE f.filepath = ?",
          [sourcePath]
        );

        if (!sourceFolder) {
          throw new Error("Source folder not found in database");
        }

        // Update the main folder
        await db.run(
          "UPDATE Folders SET name = ?, filepath = ?, parent_folder_id = ? WHERE filepath = ?",
          [
            path.basename(destPath),
            destPath,
            isRootMove ? null : destFolder.id,
            sourcePath,
          ]
        );

        // If there was a previous parent, remove old connection
        if (sourceFolder.parent_node_id) {
          await db.run(
            "DELETE FROM Node_connections WHERE origin_id = ? AND destiny_id = ?",
            [sourceFolder.parent_node_id, sourceFolder.node_id]
          );
        }

        // Create new connection if moving to a folder (whether from root or another folder)
        if (destFolder) {
          await db.run(
            "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, ?)",
            [destFolder.node_id, sourceFolder.node_id, 1]
          );
        }

        // Update all child folders' paths
        await db.run(
          "UPDATE Folders SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?",
          [sourcePath + "/", destPath + "/", sourcePath + "/%"]
        );

        // Update all documents within this folder and its subfolders
        await db.run(
          "UPDATE Documents SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?",
          [sourcePath + "/", destPath + "/", sourcePath + "/%"]
        );
      } else {
        // Get the source document's details including its current parent folder
        const sourceDoc = await db.get(
          `SELECT d.node_id, d.folder_id, f.node_id as parent_node_id 
           FROM Documents d 
           LEFT JOIN Folders f ON d.folder_id = f.id 
           WHERE d.filepath = ?`,
          [sourcePath]
        );

        if (!sourceDoc) {
          throw new Error("Source document not found in database");
        }

        // Update document record
        await db.run(
          "UPDATE Documents SET name = ?, filepath = ?, folder_id = ? WHERE filepath = ?",
          [
            path.basename(destPath),
            destPath,
            isRootMove ? null : destFolder.id,
            sourcePath,
          ]
        );

        // If there was a previous parent, remove old connection
        if (sourceDoc.parent_node_id) {
          await db.run(
            "DELETE FROM Node_connections WHERE origin_id = ? AND destiny_id = ?",
            [sourceDoc.parent_node_id, sourceDoc.node_id]
          );
        }

        // Create new connection if moving to a folder (whether from root or another folder)
        if (destFolder) {
          await db.run(
            "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, ?)",
            [destFolder.node_id, sourceDoc.node_id, 1]
          );
        }
      }

      // Move the actual file or directory
      await fs.promises.rename(sourcePath, destPath);

      await db.run("COMMIT");
      transaction = false;
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  async moveFolder(sourceFolderId, targetFolderId, isRootMove = false) {
    let transaction = false;
    try {
      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Get source folder info
      const sourceFolder = await this.getFolderInfo(sourceFolderId);
      if (!sourceFolder) throw new Error("Source folder not found");

      // Get target folder info if not moving to root
      let targetFolder = null;
      if (!isRootMove) {
        targetFolder = await this.getFolderInfo(targetFolderId);
        if (!targetFolder) throw new Error("Target folder not found");
      }

      // If moving to a folder, prevent moving a folder into itself or its subfolders
      if (
        targetFolder &&
        targetFolder.filepath.startsWith(sourceFolder.filepath)
      ) {
        throw new Error("Cannot move a folder into itself or its subfolders");
      }

      // Calculate new destination path
      const destinationPath = targetFolder
        ? path.join(targetFolder.filepath, sourceFolder.name)
        : path.join(this.filePath, sourceFolder.name);

      if (fs.existsSync(destinationPath)) {
        throw new Error(
          "A folder with this name already exists in the destination"
        );
      }

      // Get current parent folder's node_id if it exists
      const currentParentFolder = sourceFolder.parent_folder_id
        ? await this.getFolderInfo(sourceFolder.parent_folder_id)
        : null;

      // Update node connections for the source folder
      if (currentParentFolder) {
        // Remove old connection
        await db.run(
          "DELETE FROM Node_connections WHERE origin_id = ? AND destiny_id = ?",
          [currentParentFolder.node_id, sourceFolder.node_id]
        );
      }

      // Create new connection if moving to a folder
      if (targetFolder) {
        await db.run(
          "INSERT INTO Node_connections (origin_id, destiny_id, connection_type_id) VALUES (?, ?, ?)",
          [targetFolder.node_id, sourceFolder.node_id, 1]
        );
      }

      // Update the source folder's parent_folder_id and filepath
      await db.run(
        `UPDATE Folders 
         SET parent_folder_id = ?, filepath = ?
         WHERE id = ?`,
        [isRootMove ? null : targetFolderId, destinationPath, sourceFolderId]
      );

      // Get all subfolders of the source folder with their node information
      const subfolders = await db.all(
        `WITH RECURSIVE subfolder_tree AS (
           SELECT f.id, f.filepath, f.parent_folder_id, f.node_id,
                  p.node_id as parent_node_id
           FROM Folders f
           LEFT JOIN Folders p ON f.parent_folder_id = p.id
           WHERE f.parent_folder_id = ?
           UNION ALL
           SELECT f.id, f.filepath, f.parent_folder_id, f.node_id,
                  p.node_id as parent_node_id
           FROM Folders f
           LEFT JOIN Folders p ON f.parent_folder_id = p.id
           JOIN subfolder_tree st ON f.parent_folder_id = st.id
         )
         SELECT * FROM subfolder_tree`,
        [sourceFolderId]
      );

      // Update paths and node connections for all subfolders
      for (const subfolder of subfolders) {
        const newSubfolderPath = subfolder.filepath.replace(
          sourceFolder.filepath,
          destinationPath
        );

        await db.run(
          `UPDATE Folders 
           SET filepath = ?
           WHERE id = ?`,
          [newSubfolderPath, subfolder.id]
        );

        // Node connections for subfolders don't need to be updated since
        // their parent-child relationships within the moved structure remain the same
      }

      // Update paths for all documents in the source folder and subfolders
      await db.run(
        `UPDATE Documents 
         SET filepath = REPLACE(filepath, ?, ?)
         WHERE folder_id IN (
           WITH RECURSIVE subfolder_tree AS (
             SELECT id FROM Folders WHERE id = ?
             UNION ALL
             SELECT f.id 
             FROM Folders f
             JOIN subfolder_tree st ON f.parent_folder_id = st.id
           )
           SELECT id FROM subfolder_tree
         )`,
        [sourceFolder.filepath, destinationPath, sourceFolderId]
      );

      // Perform the actual file system move
      await fs.promises.rename(sourceFolder.filepath, destinationPath);

      await db.run("COMMIT");
      transaction = false;

      return { message: "Folder moved successfully", newPath: destinationPath };
    } catch (error) {
      if (transaction) {
        console.error("Error during folder move:", error);
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  // Helper function to get all subfolders
  async getAllSubfolders(folderId) {
    return await db.all(
      `WITH RECURSIVE subfolder_tree AS (
         SELECT id, filepath, parent_folder_id 
         FROM Folders 
         WHERE parent_folder_id = ?
         UNION ALL
         SELECT f.id, f.filepath, f.parent_folder_id
         FROM Folders f
         JOIN subfolder_tree st ON f.parent_folder_id = st.id
       )
       SELECT * FROM subfolder_tree`,
      [folderId]
    );
  }

  // Helper function to get folder info
  async getFolderInfo(folderId) {
    return await db.get(
      `SELECT id, name, filepath, parent_folder_id, node_id
       FROM Folders
       WHERE id = ?`,
      [folderId]
    );
  }

  // Helper function to get folder information from the database
  async getFolderInfo(folderId) {
    const row = await db.get(
      `SELECT filepath, name, node_id, parent_folder_id FROM Folders WHERE id = ?`,
      [folderId]
    );
    return row;
  }

  // Helper function to update folder and its children's paths in the database
  async updateFolderPaths(sourceFolder, destinationPath, newParentFolderId) {
    // Update the source folder's path
    await db.run(
      "UPDATE Folders SET name = ?, filepath = ?, parent_folder_id = ? WHERE id = ?",
      [
        sourceFolder.name, // Folder name remains the same
        destinationPath, // New folder path
        newParentFolderId, // New parent folder ID
        sourceFolder.id,
      ]
    );

    // Update all child folders' paths recursively
    await db.run(
      "UPDATE Folders SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?",
      [
        sourceFolder.filepath + "\\",
        destinationPath + "\\",
        sourceFolder.filepath + "\\%",
      ]
    );

    // Update all documents within the folder and its subfolders
    await db.run(
      "UPDATE Documents SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?",
      [
        sourceFolder.filepath + "\\",
        destinationPath + "\\",
        sourceFolder.filepath + "\\%",
      ]
    );
  }

  async searchDatabase(searchTerm) {
    const searchTermLower = searchTerm.toLowerCase();
    const exactPattern = searchTerm;
    const containsPattern = `%${searchTerm}%`;
    const startPattern = `${searchTerm}%`;
    const wordBoundaryPattern = `% ${searchTerm}%`;

    const folders = await db.all(
      `
      SELECT DISTINCT
        f.id,
        f.name,
        f.filepath,
        n.presence,
        CASE
          WHEN LOWER(f.name) = LOWER(?) THEN 1
          WHEN f.name LIKE ? THEN 2
          WHEN LOWER(f.name) LIKE LOWER(?) THEN 3
          WHEN LOWER(f.name) LIKE LOWER(?) THEN 4
          ELSE 5
        END as match_quality
      FROM Folders f
      JOIN Nodes n ON f.node_id = n.id
      WHERE 
        f.name LIKE ? OR
        LOWER(f.name) LIKE LOWER(?) OR
        LOWER(f.name) LIKE LOWER(?) OR
        LOWER(f.name) LIKE LOWER(?)
      ORDER BY 
        match_quality ASC,
        n.presence DESC,
        f.name ASC
      `,
      [
        exactPattern,
        startPattern,
        containsPattern,
        wordBoundaryPattern,
        startPattern,
        containsPattern,
        wordBoundaryPattern,
        `%${searchTermLower}%`,
      ]
    );

    const documents = await db.all(
      `
      SELECT DISTINCT
        d.id,
        d.name,
        d.filepath,
        d.file_extension,
        n.presence,
        f.name as folder_name,
        CASE
          WHEN LOWER(d.name) = LOWER(?) THEN 1
          WHEN d.name LIKE ? THEN 2
          WHEN LOWER(d.name) LIKE LOWER(?) THEN 3
          WHEN LOWER(d.name) LIKE LOWER(?) THEN 4
          ELSE 5
        END as match_quality
      FROM Documents d
      JOIN Nodes n ON d.node_id = n.id
      LEFT JOIN Folders f ON d.folder_id = f.id
      WHERE 
        d.name LIKE ? OR
        LOWER(d.name) LIKE LOWER(?) OR
        LOWER(d.name) LIKE LOWER(?) OR
        LOWER(d.name) LIKE LOWER(?)
      ORDER BY 
        match_quality ASC,
        n.presence DESC,
        d.name ASC
      `,
      [
        exactPattern,
        startPattern,
        containsPattern,
        wordBoundaryPattern,
        startPattern,
        containsPattern,
        wordBoundaryPattern,
        `%${searchTermLower}%`,
      ]
    );

    return {
      folders,
      documents,
      metadata: {
        total: folders.length + documents.length,
        folderCount: folders.length,
        docCount: documents.length,
      },
    };
  }

  async updateNodePresence(nodeId, presence) {
    await db.run("UPDATE Nodes SET presence = ? WHERE id = ?", [
      presence,
      nodeId,
    ]);
  }

  async readFile(absolutePath) {
    const extension = path.extname(absolutePath).toLowerCase().slice(1);

    const fileType =
      FileManager.FILE_TYPES[extension] || FileManager.FILE_TYPES.default;

    try {
      let content;

      if (fileType.binary) {
        content = await fs.promises.readFile(absolutePath);
        return;
      } else {
        content = await fs.promises.readFile(absolutePath, fileType.encoding);
      }

      return {
        content,
        extension,
        binary: fileType.binary,
        encoding: fileType.encoding,
      };
    } catch (error) {
      throw new Error(`Error reading file ${relativePath}: ${error.message}`);
    }
  }

  async writeFile(absolutePath, content) {
    const extension = path.extname(absolutePath).toLowerCase().slice(1);

    const fileType =
      FileManager.FILE_TYPES[extension] || FileManager.FILE_TYPES.default;

    try {
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

      const fileExists = await fs.promises
        .access(absolutePath)
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        throw new Error(`File ${relativePath} not found.`);
      }

      if (fileType.binary) {
        const buffer = Buffer.isBuffer(content)
          ? content
          : Buffer.from(content);
        await fs.promises.writeFile(absolutePath, buffer);
      } else {
        const textContent =
          typeof content === "string" ? content : content.toString();
        await fs.promises.writeFile(
          absolutePath,
          textContent,
          fileType.encoding
        );
      }
    } catch (error) {
      throw new Error(`Error writing file ${relativePath}: ${error.message}`);
    }
  }

  static isBinaryFile(extension) {
    const fileType =
      FileManager.FILE_TYPES[extension.toLowerCase()] ||
      FileManager.FILE_TYPES.default;
    return fileType.binary;
  }

  static getFileEncoding(extension) {
    const fileType =
      FileManager.FILE_TYPES[extension.toLowerCase()] ||
      FileManager.FILE_TYPES.default;
    return fileType.encoding || null;
  }

  async changeFileExtension(relativePath, newExtension) {
    let transaction = false;
    try {
      const absolutePath = path.join(this.filePath, relativePath);
      const newPath = absolutePath.replace(/\.[^/.]+$/, `.${newExtension}`);

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Update database record
      await db.run(
        "UPDATE Documents SET filepath = ?, file_extension = ? WHERE filepath = ?",
        [newPath, newExtension, absolutePath]
      );

      // Rename file
      await fs.promises.rename(absolutePath, newPath);

      const document = await db.get(
        "SELECT id, node_id FROM Documents WHERE filepath = ?",
        [newPath]
      );

      await db.run("COMMIT");
      transaction = false;

      return document;
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  async createFolder(name) {
    let transaction = false;
    const workspace_path = this.filePath;

    try {
      // Start a database transaction
      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // 1. Create a node for the folder (type_id 1 is for folders based on your Node_types table)
      await db.run("INSERT INTO Nodes (type_id, presence) VALUES (1, 0.0)");

      // Get the last inserted node ID
      const nodeResult = await db.get("SELECT last_insert_rowid() as id");
      const nodeId = nodeResult.id;

      // 2. Construct the folder path
      const folderPath = path.join(workspace_path, name);

      // 3. Create folder in the database
      await db.run(
        `INSERT INTO Folders (name, filepath, node_id, parent_folder_id) 
         VALUES (?, ?, ?, ?)`,
        [name, folderPath, nodeId, null]
      );

      // Get the last inserted folder ID
      const folderResult = await db.get("SELECT last_insert_rowid() as id");
      const folderId = folderResult.id;

      // 4. Create the actual folder in the filesystem
      fs.mkdir(folderPath, { recursive: true }, (err) => {
        console.error("Couldn't create folder");
      });

      // Commit the transaction
      await db.run("COMMIT");
      transaction = false;

      return {
        message: "Folder created successfully",
        folderId: folderId,
        nodeId: nodeId,
        path: folderPath,
      };
    } catch (error) {
      console.error("Error creating folder:", error);

      // Rollback the transaction in case of any errors
      if (transaction) {
        await db.run("ROLLBACK");
      }

      // If the folder was created in the filesystem but the database operations failed,
      // try to clean up the folder
      try {
        const folderPath = path.join(workspace_path, name);
        fs.rm(folderPath, { recursive: true });
      } catch (cleanupError) {
        console.error("Error cleaning up folder:", cleanupError);
      }

      throw new Error(`Failed to create folder: ${error.message}`);
    }
  }

  async renameFile(absolutePath, newName) {
    let transaction = false;
    try {
      const newPath = path.join(path.dirname(absolutePath), newName);
      const fileExtension = path.extname(newName).toLowerCase().substring(1); // Remove the dot from extension

      console.log(`Renaming file from ${absolutePath} to ${newPath}`);

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Update database (filepath, name, and file_extension)
      const result = await db.run(
        "UPDATE Documents SET filepath = ?, name = ?, file_extension = ? WHERE filepath = ?",
        [newPath, newName, fileExtension, absolutePath]
      );

      console.log(`Database update result: ${JSON.stringify(result)}`);

      // Rename file in the filesystem
      await fs.promises.rename(absolutePath, newPath);

      const document = await db.get(
        "SELECT id, node_id FROM Documents WHERE filepath = ?",
        [newPath]
      );

      await db.run("COMMIT");
      transaction = false;

      return document;
    } catch (error) {
      console.error(`Error during renameFile: ${error.message}`);
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  async renameFolder(absolutePath, newName) {
    let transaction = false;
    console.log(absolutePath);
    try {
      // Input validation
      if (!absolutePath || !newName) {
        throw new Error("Both absolutePath and newName are required");
      }

      const folderStats = await fs.promises.stat(absolutePath);
      if (!folderStats.isDirectory()) {
        throw new Error("absolutePath must be a directory");
      }

      // Calculate new paths
      const newPath = path.join(path.dirname(absolutePath), newName);
      console.log(newPath);
      // Check if target path already exists
      try {
        await fs.promises.access(newPath);
        throw new Error("A folder with this name already exists");
      } catch (err) {
        if (err.code !== "ENOENT") throw err; // Error means path doesn't exist
      }

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Verify the folder exists in the database
      const folder = await db.get("SELECT id FROM Folders WHERE filepath = ?", [
        absolutePath,
      ]);

      if (!folder) {
        throw new Error("Folder not found in database");
      }

      // Update the folder's own path in the database
      await db.run(
        "UPDATE Folders SET filepath = ?, name = ? WHERE filepath = ?",
        [newPath, newName, absolutePath]
      );

      // Update all child folders' paths more explicitly
      await db.run("UPDATE Folders SET filepath = ? WHERE filepath LIKE ?", [
        newPath + "\\",
        absolutePath + "\\%",
      ]);

      // Update all documents' paths more explicitly
      await db.run("UPDATE Documents SET filepath = ? WHERE filepath LIKE ?", [
        newPath + "\\",
        absolutePath + "\\%",
      ]);

      // Rename the folder in the filesystem last (in case DB updates fail)
      await fs.promises.rename(absolutePath, newPath);

      await db.run("COMMIT");
      transaction = false;

      return { message: "Folder renamed successfully", newPath };
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }
}

const fileManager = new FileManager();
export default fileManager;
