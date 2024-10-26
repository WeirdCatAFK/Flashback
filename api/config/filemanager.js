const fs = require("fs");
const path = require("path");
const db = require("./../config/dbmanager");

class FileManager {
  constructor() {
    const config = JSON.parse(
      fs.readFileSync("./data/config.json", "utf8")
    ).config;
    const currentWorkspace = config.workspaces.find(
      (workspace) => workspace.id === config.current.workspace_id
    );

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
  buildTreeFromResults(results) {
    const tree = {};
    const lookup = {};

    // First pass: create folder nodes
    results.forEach((row) => {
      if (!lookup[row.id]) {
        const folder = {
          id: row.id,
          name: row.name,
          type: "folder",
          presence: row.presence,
          children: [],
          documents: [], // Stores document objects
        };
        lookup[row.id] = folder;

        if (row.parent_folder_id === null) {
          tree[row.id] = folder;
        }
      }
    });

    results.forEach((row) => {
      // Add documents to their respective folders
      if (row.document_id) {
        lookup[row.id].documents.push({
          id: row.document_id,
          name: row.document_name,
          type: "document",
          presence: row.document_presence,
        });
      }

      // Build folder hierarchy
      if (row.parent_folder_id && lookup[row.id]) {
        lookup[row.parent_folder_id].children.push(lookup[row.id]);
      }
    });

    return tree;
  }
  async getDatabaseFileTree() {
    const query = `
    WITH RECURSIVE
      tree AS (
        SELECT 
          f.id, 
          f.name, 
          f.filepath, 
          f.parent_folder_id,
          n.presence,
          1 as level
        FROM Folders f
        JOIN Nodes n ON f.node_id = n.id
        WHERE f.parent_folder_id IS NULL
        
        UNION ALL
        
        SELECT 
          f.id, 
          f.name, 
          f.filepath, 
          f.parent_folder_id,
          n.presence,
          tree.level + 1
        FROM Folders f
        JOIN Nodes n ON f.node_id = n.id
        JOIN tree ON f.parent_folder_id = tree.id
      )
    SELECT 
      t.*,
      d.id as document_id,
      d.name as document_name,
      d.filepath as document_path,
      dn.presence as document_presence
    FROM tree t
    LEFT JOIN Documents d ON d.folder_id = t.id
    LEFT JOIN Nodes dn ON d.node_id = dn.id
    ORDER BY t.level, t.name, d.name
  `;

    const results = await db.all(query);
    return this.buildTreeFromResults(results);
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
      FileOperations.FILE_TYPES[extension] || FileOperations.FILE_TYPES.default;

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
      FileOperations.FILE_TYPES[extension] || FileOperations.FILE_TYPES.default;

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
      FileOperations.FILE_TYPES[extension.toLowerCase()] ||
      FileOperations.FILE_TYPES.default;
    return fileType.binary;
  }

  static getFileEncoding(extension) {
    const fileType =
      FileOperations.FILE_TYPES[extension.toLowerCase()] ||
      FileOperations.FILE_TYPES.default;
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
module.exports = fileManager;
