import {
  request,
  requestWithEtag,
  isStale,
  upload,
  uploadWithProgress,
  getBaseUrl,
  getToken,
  appendToken,
} from "./client.js";

export const listFolder = (path = "") =>
  request("GET", `/api/documents/list?path=${encodeURIComponent(path)}`);
export const getTags = () => request("GET", "/api/documents/tags");
export const getEntityTags = (path, isFolder = false) =>
  request(
    "GET",
    `/api/documents/tags/entity?path=${encodeURIComponent(path)}&isFolder=${isFolder}`,
  );
export const getSidecar = (path, isFolder = false) =>
  request(
    "GET",
    `/api/documents/sidecar?path=${encodeURIComponent(path)}&isFolder=${isFolder}`,
  );
export const getGraph = () => request("GET", "/api/documents/graph");

/** Reads the sidecar, applies transform and writes it back with ifMatch. A concurrent write makes the server answer 409, and the merge runs again on the fresh sidecar. */
export async function mergeMetadata(path, transform, isFolder = false) {
  for (let attempt = 1; ; attempt++) {
    const { data, etag } = await requestWithEtag(
      "GET",
      `/api/documents/sidecar?path=${encodeURIComponent(path)}&isFolder=${isFolder}`,
    );
    const next = transform(data ?? {});
    try {
      await updateMetadata(path, next, isFolder, { ifMatch: etag ?? undefined });
      return next;
    } catch (err) {
      if (!isStale(err) || attempt >= 3) throw err;
    }
  }
}

export const createFolder = (name, parentPath) =>
  request("POST", "/api/documents/folder", { name, parentPath });
export const readFile = (path) =>
  request("GET", `/api/documents/read?path=${encodeURIComponent(path)}`);
export const createFile = (name, parentPath) =>
  request("POST", "/api/documents/file", { name, parentPath });
export const updateFile = (path, content, metadata, { ifMatch } = {}) =>
  request("PUT", "/api/documents/file", { path, content, metadata, ifMatch });
export const updateMetadata = (
  path,
  metadata,
  isFolder = false,
  { ifMatch } = {},
) =>
  request("PUT", "/api/documents/metadata", {
    path,
    metadata,
    isFolder,
    ifMatch,
  });
export const documentCoverUrl = (path, file) =>
  appendToken(`${getBaseUrl()}/api/media/file?docPath=${encodeURIComponent(path)}&name=${encodeURIComponent(file)}`);

export const uploadDocumentCover = (path, file) => {
  const form = new FormData();
  form.append("path", path);
  form.append("file", file);
  return upload("/api/documents/cover", form);
};

export const setDocumentCover = (path, change) =>
  request("PUT", "/api/documents/cover", { path, ...change });

export const removeDocumentCover = (path) =>
  request("DELETE", "/api/documents/cover", { path });

export const deleteItem = (path, isFolder) =>
  request("DELETE", "/api/documents", { path, isFolder });
export const moveItem = (srcPath, destPath, isFolder) =>
  request("POST", "/api/documents/move", { srcPath, destPath, isFolder });
export const renameItem = (path, newName, isFolder) =>
  request("POST", "/api/documents/rename", { path, newName, isFolder });

export const importFileWithProgress = (formData, onProgress) =>
  uploadWithProgress("/api/documents/import", formData, onProgress);
export const importZipWithProgress = (formData, onProgress) =>
  uploadWithProgress("/api/documents/import/zip", formData, onProgress);

export const ankiSessionMediaSrc = (sessionId, name) =>
  sessionId && name
    ? appendToken(
        `${getBaseUrl()}/api/documents/import/anki/media?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`,
      )
    : null;

export const applyAnkiMapping = (sessionId, mapping, targetPath = "") => {
  const fd = new FormData();
  fd.append("sessionId", sessionId);
  fd.append("mapping", JSON.stringify(mapping));
  fd.append("targetPath", targetPath);
  return uploadWithProgress("/api/documents/import/anki", fd, () => {});
};

export const getDocumentByHash = (hash) =>
  request("GET", `/api/documents/by-hash/${encodeURIComponent(hash)}`);

export const rawDocumentUrl = (path) =>
  appendToken(
    `${getBaseUrl()}/api/documents/raw?path=${encodeURIComponent(path)}`,
  );

export async function fetchRaw(path) {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(
    `${getBaseUrl()}/api/documents/raw?path=${encodeURIComponent(path)}`,
    { headers },
  );
  if (!res.ok)
    throw Object.assign(new Error(`Failed to load file (${res.status})`), {
      status: res.status,
    });
  return res.arrayBuffer();
}

export const clipYoutube = (url, parentPath = "") =>
  request("POST", "/api/documents/youtube", { url, parentPath });
export const clipUrl = (url, parentPath = "") =>
  request("POST", "/api/documents/clip", { url, parentPath });
export const setYoutubeSource = (path, url) =>
  request("PUT", "/api/documents/youtube", { path, url });
export const setClipSource = (path, url) =>
  request("PUT", "/api/documents/clip", { path, url });
export const fetchYoutubeTranscript = (path, lang) =>
  request("POST", "/api/documents/youtube/transcript", { path, lang });

export const saveClipAsset = (path, href) =>
  request("POST", "/api/documents/clip/asset", { path, href });
