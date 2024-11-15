# API Documentation

## 1. Config Endpoint

### 1.1 Get Configuration

- **Endpoint:** `GET /config/`
- **Description:** Retrieves the current configuration.
- **Response:** JSON object containing the configuration.
- **Example:**

```javascript
axios.get('/config/')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 1.2 Update Configuration

- **Endpoint:** `PUT /config/`
- **Description:** Updates the configuration with the provided new configuration.
- **Request Body:**
  ```json
  {
    "newConfig": { ... }
  }
  ```
- **Response:** Success message or error message.
- **Example:**

```javascript
axios.put('/config/', {
    newConfig: {{
    "config": {
        "current": {
            "workspace_id": 0
        },
        "workspaces": [
            {
                "id": 0,
                "name": "Flashback",
                "description": "",
                "path": "./../.flashback",
                "db": "src/api/data/flashback.db"
            }
        ]
    }
}}
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 1.3 Reset Configuration

- **Endpoint:** `POST /config/reset`
- **Description:** Resets the configuration to its default.
- **Response:** Success message or error message.
- **Example:**

```javascript
axios.post('/config/reset')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 1.4 Manage Workspaces

- **Endpoint:** `USE /config/workspaces`
- **Description:** This endpoint allows for the management of workspaces within the application. The following operations can be performed:

  #### 1.4.1 Get All Workspaces


  - **Method:** `GET /config/workspaces/`
  - **Description:** Retrieves a list of all workspaces configured in the application.
  - **Response:** JSON array of workspaces.
  - **Example:**

  ```javascript
  axios.get('/config/workspaces/')
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

  #### 1.4.2 Get Current Workspace

  - **Method:** `GET /config/workspaces/current`
  - **Description:** Retrieves the currently active workspace.
  - **Response:** JSON object representing the current workspace.
  - **Example:**

  ```javascript
  axios.get('/config/workspaces/current')
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

  #### 1.4.3 Get Workspace by ID

  - **Method:** `GET /config/workspaces/:id`
  - **Description:** Retrieves a workspace by its ID.
  - **Example:**

  ```javascript
  axios.get('/config/workspaces/0') // Replace 0 with the workspace ID
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

  #### 1.4.4 Create a New Workspace

  - **Method:** `POST /config/workspaces/`
  - **Description:** Creates a new workspace with the provided details.
  - **Request Body:**

  ```json
  {
    "name": "New Workspace",
    "description": "A description of the workspace",
    "path": "./path/to/workspace",
    "db": "path/to/database.db"
  }
  ```

  - **Example:**

  ```javascript
  axios.post('/config/workspaces/', {
      name: 'New Workspace',
      description: 'A description of the workspace',
      path: './path/to/workspace',
      db: 'path/to/database.db'
    })
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

  #### 1.4.5 Change Current Workspace

  - **Method:** `PUT /config/workspaces/current`
  - **Description:** Sets the current workspace by ID.
  - **Request Body:**

  ```json
  {
    "workspace_id": 1
  }
  ```

  - **Example:**

  ```javascript
  axios.put('/config/workspaces/current', {
      workspace_id: 1 // Replace 1 with the desired workspace ID
    })
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

  #### 1.4.6 Rename a Workspace

  - **Method:** `PUT /config/workspaces/:id/name`
  - **Description:** Renames a workspace by ID.
  - **Request Body:**

  ```json
  {
    "new_name": "Renamed Workspace"
  }
  ```

  - **Example:**

  ```javascript
  axios.put('/config/workspaces/0/name', {
      new_name: 'Renamed Workspace'
    })
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

  #### 1.4.7 Delete a Workspace

  - **Method:** `DELETE /config/workspaces/:id`
  - **Description:** Deletes a workspace by ID.
  - **Example:**

  ```javascript
  axios.delete('/config/workspaces/0') // Replace 0 with the workspace ID to delete
    .then(response => console.log(response.data))
    .catch(error => console.error(error));
  ```

## 2. Files Endpoint

### 2.1 Get File Tree

- **Endpoint:** `GET /files/tree`
- **Description:** Retrieves the file tree structure.
- **Response:** JSON object representing the file tree.
- **Example:**

```javascript
axios.get('/files/tree')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.2 Search Files

- **Endpoint:** `GET /files/search`
- **Description:** Searches for files and folders by term.
- **Query Parameters:**
  - `term`: The search term.
- **Response:** Search results.
- **Example:**

```javascript
axios.get('/files/search', { params: { term: 'example' } })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.3 Read File Content

- **Endpoint:** `GET /files/:path(*)`
- **Description:** Reads file content by the specified path.
- **Example:**

```javascript
axios.get('/files/my-folder/my-file.txt')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.4 Create a File

- **Endpoint:** `POST /files/:path(*)`
- **Description:** Creates a new file with specified content.
- **Request Body:**
  ```json
  {
    "content": "File content here"
  }
  ```
- **Example:**

```javascript
axios.post('/files/my-folder/my-file.txt', {
    content: 'Hello, World!'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.5 Update File Content

- **Endpoint:** `PUT /files/:path(*)`
- **Description:** Updates the content of an existing file.
- **Request Body:**
  ```json
  {
    "content": "Updated file content"
  }
  ```
- **Example:**

```javascript
axios.put('/files/my-folder/my-file.txt', {
    content: 'Updated content'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.6 Change File Extension

- **Endpoint:** `PATCH /files/:path(*)/extension`
- **Description:** Changes the file extension of the specified file.
- **Request Body:**
  ```json
  {
    "newExtension": "newext"
  }
  ```
- **Example:**

```javascript
axios.patch('/files/my-folder/my-file.txt/extension', {
    newExtension: 'md'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.7 Move a File

- **Endpoint:** `POST /files/:path(*)/move`
- **Description:** Moves a file to a new destination.
- **Request Body:**
  ```json
  {
    "destination": "/new-folder/my-file.txt"
  }
  ```
- **Example:**

```javascript
axios.post('/files/my-folder/my-file.txt/move', {
    destination: '/new-folder/my-file.txt'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.8 Rename a File

- **Endpoint:** `PUT /files/:path(*)/rename`
- **Description:** Renames a file.
- **Request Body:**
  ```json
  {
    "newName": "new-file-name.txt"
  }
  ```
- **Example:**

```javascript
axios.put('/files/my-folder/my-file.txt/rename', {
    newName: 'new-file-name.txt'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.9 Delete a File

- **Endpoint:** `DELETE /files/:path(*)`
- **Description:** Deletes the specified file.
- **Example:**

```javascript
axios.delete('/files/my-folder/my-file.txt')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.10 Create a Folder

- **Endpoint:** `POST /files/folder/:path(*)`
- **Description:** Creates a new folder at the specified path.
- **Example:**

```javascript
axios.post('/files/folder/my-new-folder')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 2.11 Move a Folder

- **Endpoint:** `POST /files/folder/:path(*)/move`
- **Description:** Moves a folder to a new destination.
- **Request Body:**
  ```json
  {
    "destination": "/new-parent-folder/"
  }
  ```
- **Example:**

```javascript
axios.post('/files/folder/my-folder/move', {
    destination: '/new-parent-folder/'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

---

## 3. Flashcards Endpoint

### 3.1 Create a Flashcard

- **Endpoint:** `POST /`
- **Description:** Creates a new flashcard linked to a document.
- **Request Body:**
  ```json
  {
    "documentId": "your-document-id",
    "content": "Flashcard content"
  }
  ```
- **Example:**

```javascript
axios.post('/flashcards/', {
    documentId: 'your-document-id',
    content: 'Flashcard content'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 3.2 Get Flashcards by Document

- **Endpoint:** `GET /document/:documentId`
- **Description:** Gets all flashcards for a specific document.
- **Example:**

```javascript
axios.get('/flashcards/document/your-document-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 3.3 Get Flashcards by Folder

- **Endpoint:** `GET /folder/:folderId`
- **Description:** Gets all flashcards in a specific folder.
- **Example:**

```javascript
axios.get('/flashcards/folder/your-folder-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 3.4 Add Media to Flashcard

- **Endpoint:** `POST /:id/media`
- **Description:** Adds media to a specific flashcard.
- **Request Body:**
  ```json
  {
    "media": { ... }
  }
  ```
- **Example:**

```javascript
axios.post('/flashcards/your-flashcard-id/media', {
    media: { /* media data */ }
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 3.5 Update TTS Voice

- **Endpoint:** `PUT /:id/tts`
- **Description:** Updates the TTS voice of a flashcard.
- **Request Body:**
  ```json
  {
    "voice": "new-voice"
  }
  ```
- **Example:**

```javascript
axios.put('/flashcards/your-flashcard-id/tts', {
    voice: 'new-voice'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 3.6 Update Text Renderer

- **Endpoint:** `PUT /:id/renderer`
- **Description:** Updates the text renderer of a flashcard.
- **Request Body:**
  ```json
  {
    "renderer": "new-renderer"
  }
  ```
- **Example:**

```javascript
axios.put('/flashcards/your-flashcard-id/renderer', {
    renderer: 'new-renderer'
  })
  .then(response => console.log(response.data))
  .catch(error =>

```

## 4. Tags Endpoints

### 4.1 Create a Tag

- **Endpoint:** `POST /tags`
- **Description:** Creates a new tag with the specified name if it does not already exist.
- **Request Body:**
  ```json
  {
    "name": "Tag Name"
  }
  ```
- **Response:** The tag's ID with a 201 status or a message if the tag already exists.
- **Example:**

```javascript
axios.post('/tags/', {
    name: 'New Tag'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.2 Get All Tags

- **Endpoint:** `GET /tags`
- **Description:** Retrieves all tags with their presence.
- **Response:** Array of tags with presence information.
- **Example:**

```javascript
axios.get('/tags/')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.3 Rename a Tag

- **Endpoint:** `PUT /tags/:tagId`
- **Description:** Renames a tag by ID.
- **Request Body:**
  ```json
  {
    "newName": "Updated Tag Name"
  }
  ```
- **Response:** Success message with a 200 status, or a 404 if the tag is not found.
- **Example:**

```javascript
axios.put('/tags/your-tag-id', {
    newName: 'Updated Tag Name'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.4 Delete a Tag

- **Endpoint:** `DELETE /tags/:tagId`
- **Description:** Deletes a tag by ID.
- **Response:** Success message with a 200 status, or a 404 if not found.
- **Example:**

```javascript
axios.delete('/tags/your-tag-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.5 Add a Tag to a Document

- **Endpoint:** `POST /document/:documentId/tag/:tagId`
- **Description:** Adds a tag to a document and its flashcards.
- **Response:** Success message with a 200 status or 404 if the document is not found.
- **Example:**

```javascript
axios.post('/tags/document/your-document-id/tag/your-tag-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.6 Add a Tag to a Folder

- **Endpoint:** `POST /folder/:folderId/tag/:tagId`
- **Description:** Adds a tag to a folder and its contents (documents and flashcards).
- **Response:** Success message with a 200 status or 404 if the folder is not found.
- **Example:**

```javascript
axios.post('/tags/folder/your-folder-id/tag/your-tag-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.7 Remove a Tag from a Document

- **Endpoint:** `DELETE /document/:documentId/tag/:tagId`
- **Description:** Removes a tag from a document and its flashcards.
- **Response:** Success message with a 200 status or 404 if not found.
- **Example:**

```javascript
axios.delete('/tags/document/your-document-id/tag/your-tag-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.8 Get Tags for a Node

- **Endpoint:** `GET tags/node/:nodeId`
- **Description:** Retrieves all tags for a specified node, indicating whether they are inherited.
- **Response:** Array of tags for the specified node.
- **Example:**

```javascript
axios.get('/tags/node/your-node-id')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.9 Add a Tag to a Flashcard

- **Endpoint:** `POST tags/flashcard/:flashcardId`
- **Description:** Adds a tag to a flashcard. Creates the tag if it does not exist.
- **Request Body:**
  ```json
  {
    "name": "Tag Name"
  }
  ```
- **Response:** The tag's ID with a 201 status or 400 if the tag name is missing.
- **Example:**

```javascript
axios.post('/tags/flashcard/your-flashcard-id', {
    name: 'Flashcard Tag'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 4.10 Update a Tag on a Flashcard

- **Endpoint:** `PUT tags/flashcard/:flashcardId/tag/:tagId`
- **Description:** Updates a tag on a flashcard to a new name, linking to an existing tag if it matches the new name.
- **Request Body:**
  ```json
  {
    "newName": "Updated Tag Name"
  }
  ```
- **Response:** Success message with a 200 status.
- **Example:**

```javascript
axios.put('/tags/flashcard/your-flashcard-id/tag/your-tag-id', {
    newName: 'Updated Tag Name'
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

## 5. Upload Endpoints

### 5.1 Upload a File

- **Endpoint:** `POST /upload`
- **Description:** Uploads a file and creates any necessary folders in the database.
- **Request Body:** Form data containing the file and optional metadata.
  - **Field:** `file` (the file to be uploaded)
  - **Field:** `metadata` (optional metadata for the file)
- **Response:** The uploaded file's details with a 201 status or a 500 status on failure.
- **Example:**

```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]); // assuming fileInput is an <input type="file">

axios.post('/upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

Thank you for providing the correct implementation of the nodes router. Here’s the updated documentation for the Nodes endpoints, along with Axios examples for each one.

---

## 6. Nodes Endpoints

### 6.1 Get Graph Data

- **Endpoint:** `GET /nodes/graph`
- **Description:** Returns graph data formatted for a D3.js force-directed graph visualization, including nodes and links derived from the database.
- **Response:** Graph data with a 200 status on success or a 500 status on error.
- **Example:**

```javascript
axios.get('/nodes/graph')
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 6.2 Get Node Details

- **Endpoint:** `GET /nodes/:id/details`
- **Description:** Fetches details of a specific node, including connected nodes for hover/click interactions.
- **Response:** Node details, connected nodes, and metrics with a 200 status on success or a 404 status if the node is not found, or a 500 status on error.
- **Example:**

```javascript
const nodeId = '12345'; // replace with the actual node ID
axios.get(`/nodes/${nodeId}/details`)
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

### 6.3 Update Node Position

- **Endpoint:** `PATCH /nodes/:id/position`
- **Description:** Updates the position of a node in the graph layout by saving the coordinates to the database.
- **Request Body:**
  ```json
  {
    "x": 100,
    "y": 200
  }
  ```
- **Response:** Success message with a 200 status or a 500 status on error.
- **Example:**

```javascript
const nodeId = '12345'; // replace with the actual node ID
axios.patch(`/nodes/${nodeId}/position`, {
    x: 100,
    y: 200
  })
  .then(response => console.log(response.data))
  .catch(error => console.error(error));
```

---
