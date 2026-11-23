import { request, getBaseUrl, getToken, appendToken } from "./client.js";

export const listBookImages = (path) =>
  request("GET", `/api/reader/images?path=${encodeURIComponent(path)}`);

export const bookImageSrc = (path, href) => {
  if (!path || !href) return null;
  return appendToken(
    `${getBaseUrl()}/api/reader/image?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
  );
};

export async function fetchBookImageFile(path, href, name) {
  return fetchAsFile(
    `${getBaseUrl()}/api/reader/image?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
    href,
    name,
  );
}

export const listDocumentMedia = (path) =>
  request("GET", `/api/reader/media?path=${encodeURIComponent(path)}`);

export const documentMediaSrc = (path, href) => {
  if (!path || !href) return null;
  return appendToken(
    `${getBaseUrl()}/api/reader/media-file?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
  );
};

export async function fetchDocumentMediaFile(path, href, name) {
  return fetchAsFile(
    `${getBaseUrl()}/api/reader/media-file?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
    href,
    name,
  );
}

async function fetchAsFile(url, href, name) {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), {
      status: res.status,
    });
  }
  const blob = await res.blob();
  return new File([blob], name || href.split("/").pop(), { type: blob.type });
}
