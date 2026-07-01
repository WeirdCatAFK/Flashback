import { request, upload, uploadWithProgress } from './client.js';

export const listFolder    = (path = '')          => request('GET', `/api/documents/list?path=${encodeURIComponent(path)}`);
export const getTags          = ()                      => request('GET', '/api/documents/tags');
export const getEntityTags    = (path, isFolder = false) => request('GET', `/api/documents/tags/entity?path=${encodeURIComponent(path)}&isFolder=${isFolder}`);
export const getSidecar       = (path, isFolder = false) => request('GET', `/api/documents/sidecar?path=${encodeURIComponent(path)}&isFolder=${isFolder}`);
export const getGraph      = ()                   => request('GET', '/api/documents/graph');

export const createFolder  = (name, parentPath)   => request('POST', '/api/documents/folder',  { name, parentPath });
export const readFile      = (path)               => request('GET', `/api/documents/read?path=${encodeURIComponent(path)}`);
export const createFile    = (name, parentPath)   => request('POST', '/api/documents/file',    { name, parentPath });
export const updateFile     = (path, content, metadata)      => request('PUT', '/api/documents/file', { path, content, metadata });
export const updateMetadata = (path, metadata, isFolder = false) => request('PUT', '/api/documents/metadata', { path, metadata, isFolder });
export const deleteItem    = (path, isFolder)               => request('DELETE', '/api/documents',       { path, isFolder });
export const moveItem      = (srcPath, destPath, isFolder)  => request('POST', '/api/documents/move', { srcPath, destPath, isFolder });
export const renameItem    = (path, newName, isFolder)      => request('POST', '/api/documents/rename', { path, newName, isFolder });

export const importFileWithProgress = (formData, onProgress)    => uploadWithProgress('/api/documents/import', formData, onProgress);
export const importZipWithProgress = (formData, onProgress)     => uploadWithProgress('/api/documents/import/zip', formData, onProgress);

export const getDocumentByHash = (hash) => request('GET', `/api/documents/by-hash/${encodeURIComponent(hash)}`);
