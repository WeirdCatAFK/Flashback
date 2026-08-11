import { request, getBaseUrl, getToken, appendToken } from './client.js';

// The renderer's half of /api/reader. That route was built for the MCP server, which
// reads books it cannot render; this is the other client — the card form's book-image
// picker, which needs the pictures an EPUB holds rather than its prose.

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
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const url = `${getBaseUrl()}/api/reader/image?path=${encodeURIComponent(path)}&href=${encodeURIComponent(href)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  const blob = await res.blob();
  return new File([blob], name || href.split('/').pop(), { type: blob.type });
}
