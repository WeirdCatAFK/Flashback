# API Documentation

## 1. Config Endpoints

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
    newConfig: { key: 'value' }
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
- **Description:** Manage workspaces (detailed actions need to be defined).
- **Example:**

```javascript
// Example not specified as it depends on workspace actions
```

---

## 2. Files Endpoints

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

## 3. Flashcards Endpoints

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
