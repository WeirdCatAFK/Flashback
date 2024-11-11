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
    // Use Map for better performance with large datasets
    const folderMap = new Map();
    const rootItems = [];
    const fileTypeCache = new Map();

    const getFileType = (fileExtension) => {
      if (fileTypeCache.has(fileExtension)) {
        return fileTypeCache.get(fileExtension);
      }
      const fileType =
        FileManager.FILE_TYPES[fileExtension] || FileManager.FILE_TYPES.default;
      fileTypeCache.set(fileExtension, fileType);
      return fileType;
    };

    // Process folders first using Set for tracking
    const processedFolders = new Set();

    for (const row of results) {
      if (row.folder_id && !processedFolders.has(row.folder_id)) {
        const folder = {
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

    // Process documents in a single pass
    for (const row of results) {
      if (row.document_id) {
        const fileType = getFileType(row.file_extension);

        const document = {
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

    return {
      id: 0,
      name: "root",
      is_folder: true,
      presence: 0,
      items: rootItems,
    };
  }
  async createFile(relativePath, content) {
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
      const parentFolder = await this.createOrGetFolderEntry(
        path.basename(dirPath),
        dirPath
      );

      // Create document node and entry
      const nodeId = await this.createDatabaseNode("Document");
      await db.run(
        "INSERT INTO Documents (folder_id, name, filepath, file_extension, node_id) VALUES (?, ?, ?, ?, ?)",
        [parentFolder.id, fileName, absolutePath, fileExtension, nodeId]
      );

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

  async deletePath(relativePath) {
    let transaction = false;
    try {
      const absolutePath = path.join(this.filePath, relativePath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Path ${relativePath} not found.`);
      }

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      const stats = await fs.promises.stat(absolutePath);
      if (stats.isDirectory()) {
        await db.run("DELETE FROM Folders WHERE filepath = ?", [absolutePath]);
        await fs.promises.rm(absolutePath, { recursive: true });
      } else {
        await db.run("DELETE FROM Documents WHERE filepath = ?", [
          absolutePath,
        ]);
        await fs.promises.unlink(absolutePath);
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

  async movePath(sourceRelativePath, destRelativePath) {
    let transaction = false;
    try {
      const sourcePath = path.join(this.filePath, sourceRelativePath);
      const destPath = path.join(this.filePath, destRelativePath);
      const destDir = path.dirname(destPath);

      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source ${sourceRelativePath} not found.`);
      }

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Ensure destination directory exists
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const destFolder = await this.createOrGetFolderEntry(
        path.basename(destDir),
        destDir
      );

      const stats = await fs.promises.stat(sourcePath);
      if (stats.isDirectory()) {
        await db.run(
          "UPDATE Folders SET name = ?, filepath = ?, parent_folder_id = ? WHERE filepath = ?",
          [path.basename(destPath), destPath, destFolder.id, sourcePath]
        );
      } else {
        await db.run(
          "UPDATE Documents SET name = ?, filepath = ?, folder_id = ? WHERE filepath = ?",
          [path.basename(destPath), destPath, destFolder.id, sourcePath]
        );
      }

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

  async readFile(relativePath) {
    const absolutePath = path.join(this.filePath, relativePath);
    const extension = path.extname(absolutePath).toLowerCase().slice(1);

    const fileType =
      FileManager.FILE_TYPES[extension] || FileManager.FILE_TYPES.default;

    try {
      let content;

      if (fileType.binary) {
        content = await fs.promises.readFile(absolutePath);
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

  async writeFile(relativePath, content) {
    const absolutePath = path.join(this.filePath, relativePath);
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

  async createFolder(relativePath) {
    let transaction = false;
    try {
      const absolutePath = path.join(this.filePath, relativePath);
      const parentPath = path.dirname(absolutePath);
      const folderName = path.basename(absolutePath);

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Ensure parent directory exists
      if (!fs.existsSync(parentPath)) {
        fs.mkdirSync(parentPath, { recursive: true });
      }
      const parentFolder = await this.createOrGetFolderEntry(
        path.basename(parentPath),
        parentPath
      );

      // Create the new folder
      fs.mkdirSync(absolutePath);
      const result = await this.createOrGetFolderEntry(
        folderName,
        absolutePath,
        parentFolder.id
      );

      await db.run("COMMIT");
      transaction = false;

      return result;
    } catch (error) {
      if (transaction) {
        await db.run("ROLLBACK");
      }
      throw error;
    }
  }

  async renameFile(relativePath, newName) {
    let transaction = false;
    try {
      const absolutePath = path.join(this.filePath, relativePath);
      const newPath = path.join(path.dirname(absolutePath), newName);

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      // Update database
      await db.run("UPDATE Documents SET filepath = ? WHERE filepath = ?", [
        newPath,
        absolutePath,
      ]);

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
  async renameFolder(relativePath, newName) {
    let transaction = false;
    try {
      const absolutePath = path.join(this.filePath, relativePath);
      const folderStats = await fs.promises.stat(absolutePath);

      if (!folderStats.isDirectory()) {
        throw new Error("relativePath must be a directory");
      }

      const newPath = path.join(path.dirname(absolutePath), newName);

      await db.run("BEGIN TRANSACTION");
      transaction = true;

      await db.run("UPDATE Folders SET filepath = ? WHERE filepath = ?", [
        newPath,
        absolutePath,
      ]);

      await db.run(
        "UPDATE Documents SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?",
        [absolutePath, newPath, `${absolutePath}%`]
      );

      // Rename the folder in the filesystem
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
