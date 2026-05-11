import { request, upload } from './client.js';

export const listFolder    = (path = '')          => request('GET', `/api/documents/list?path=${encodeURIComponent(path)}`);
export const readFile      = (path)               => request('GET', `/api/documents/read?path=${encodeURIComponent(path)}`);
export const searchDocs    = (q)                  => request('GET', `/api/documents/search?q=${encodeURIComponent(q)}`);
export const getGraph      = ()                   => request('GET', '/api/documents/graph');

export const createFolder  = (name, parentPath)   => request('POST', '/api/documents/folder',  { name, parentPath });
export const createFile    = (name, parentPath)   => request('POST', '/api/documents/file',    { name, parentPath });
export const updateFile    = (path, content, metadata) => request('PUT', '/api/documents/file', { path, content, metadata });
export const deleteItem    = (path, isFolder)     => request('DELETE', '/api/documents',       { path, isFolder });
export const moveItem      = (srcPath, destPath, isFolder) => request('POST', '/api/documents/move', { srcPath, destPath, isFolder });
export const renameItem    = (path, newName, isFolder)     => request('POST', '/api/documents/rename', { path, newName, isFolder });

export const importFile    = (formData)           => upload('/api/documents/import', formData);
export const importZip     = (formData)           => upload('/api/documents/import/zip', formData);
