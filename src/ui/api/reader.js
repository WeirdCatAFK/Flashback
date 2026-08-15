import { request, getBaseUrl, getToken, appendToken } from './client.js';

// The renderer's half of /api/reader. That route was built for the MCP server, which
// reads books it cannot render; this is the other client — the card form's media
// pickers, which need the pictures and sound a document holds rather than its prose.
//
// Two pairs live here because the endpoints they call are two generations of the same
// idea: `/images`+`/image` are EPUB-only and predate clips carrying media, while
// `/media`+`/media-file` serve either format. The book helpers stay because the book
// picker and the book MCP tools are built on their exact response shape.

/**
 * Every image an EPUB declares, in reading order, as metadata only.
 * @param {string} path - relative path to the EPUB from the workspace root.
 * @returns {Promise<{ path, format, total, images: Array<{
 *   index, href, name, mediaType, bytes, alt, caption, section, sectionIndex, isCover }> }>}
 */
export const listBookImages = (path) =>
  request('GET', `/api/reader/images?path=${encodeURIComponent(path)}`);

/**
 * Streamable URL for one image inside a book — for an <img src>, which can't send an
 * Authorization header, so the token rides along as a query param (same as media URLs).
 * @param {string} path - relative path to the EPUB.
 * @param {string} href - the image's `href` from listBookImages.
 * @returns {string|null}
 */
export const bookImageSrc = (path, href) => {
  if (!path || !href) return null;
  return appendToken(
    `${getBaseUrl()}/api/reader/image?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
  );
};

/**
 * The same image as a File, so a picked figure drops straight into the card form's
 * upload slot and travels the ordinary createVanillaCard path — the form never learns
 * that this one didn't come from the user's disk.
 * @param {string} path - relative path to the EPUB.
 * @param {string} href - the image's `href` from listBookImages.
 * @param {string} [name] - file name to give it; defaults to the name it has in the book.
 * @returns {Promise<File>}
 */
export async function fetchBookImageFile(path, href, name) {
  return fetchAsFile(
    `${getBaseUrl()}/api/reader/image?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
    href,
    name,
  );
}

/**
 * Every asset a document carries — an EPUB's figures or a saved clip's downloaded
 * pictures and sound — in document order, as metadata only. Each entry is tagged
 * `kind: 'image' | 'audio'`; a clip entry also carries `heading`, `cached` and, when
 * cached, a real `path` in the vault.
 * @param {string} path - relative path to the document from the workspace root.
 * @returns {Promise<{ path, format, total, media: Array<object> }>}
 */
export const listDocumentMedia = (path) =>
  request('GET', `/api/reader/media?path=${encodeURIComponent(path)}`);

/**
 * Streamable URL for one asset — for an `<img src>` or `<audio src>`, neither of which
 * can send an Authorization header, so the token rides along as a query param.
 * @param {string} path - relative path to the document.
 * @param {string} href - the asset's `href` from listDocumentMedia.
 * @returns {string|null}
 */
export const documentMediaSrc = (path, href) => {
  if (!path || !href) return null;
  return appendToken(
    `${getBaseUrl()}/api/reader/media-file?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
  );
};

/**
 * The same asset as a File, so a picked picture or sound drops straight into the card
 * form's upload slot and travels the ordinary createVanillaCard path.
 * @param {string} path - relative path to the document.
 * @param {string} href - the asset's `href` from listDocumentMedia.
 * @param {string} [name] - file name to give it; defaults to the name it has in the document.
 * @returns {Promise<File>}
 */
export async function fetchDocumentMediaFile(path, href, name) {
  return fetchAsFile(
    `${getBaseUrl()}/api/reader/media-file?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`,
    href,
    name,
  );
}

// Shared by both fetch helpers: `request` can't be used here because these responses
// are bytes, not JSON, so the Bearer header has to be assembled by hand.
async function fetchAsFile(url, href, name) {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  const blob = await res.blob();
  return new File([blob], name || href.split('/').pop(), { type: blob.type });
}
