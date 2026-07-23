import { request, uploadWithProgress, getBaseUrl, getToken } from './client.js';

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

// Fetch a document's raw bytes with auth. Unlike PDF (which hands pdf.js a
// tokenised URL for a single request), epub.js unzips from an ArrayBuffer and
// serves every chapter/image from memory — so we pull the whole file once here
// with the bearer header and never expose sub-resource requests to auth.
export async function fetchRaw(path) {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${getBaseUrl()}/api/documents/raw?path=${encodeURIComponent(path)}`, { headers });
  if (!res.ok) throw Object.assign(new Error(`Failed to load file (${res.status})`), { status: res.status });
  return res.arrayBuffer();
}

export const clipYoutube = (url, parentPath = '') => request('POST', '/api/documents/youtube', { url, parentPath });
export const clipUrl     = (url, parentPath = '') => request('POST', '/api/documents/clip',    { url, parentPath });
export const setYoutubeSource = (path, url) => request('PUT', '/api/documents/youtube', { path, url });
export const setClipSource    = (path, url) => request('PUT', '/api/documents/clip',    { path, url });
export const fetchYoutubeTranscript = (path, lang) => request('POST', '/api/documents/youtube/transcript', { path, lang });
