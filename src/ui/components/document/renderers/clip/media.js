/**
 * A clip's media: which links are playable sound, how a saved asset's `src` is
 * pointed at the API, what the pointer is over, and where its save button goes.
 * `data-href` is the identifier everything speaks in — the reference the clip
 * file actually holds — because the live `src` is either a tokenised API URL or
 * whatever the browser resolved a web asset to.
 */

import { mediaFileUrl } from '../../../../api/media';
import { toLayoutRect, layoutViewport } from '../../../../utils/uiZoom';

/**
 * Mirrors the predicate in mcpReader.js and documents.js. MIDI is out because no
 * browser plays it; a last segment with a colon (`File:Something.ogg`) is a
 * description page, not the file.
 */
const PLAYABLE_SOUND_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)(\?|#|$)/i;
export function isSoundLink(href) {
  if (!href) return false;
  const segment = href.split('?')[0].split('#')[0].split('/').pop() || '';
  if (segment.includes(':')) return false;
  return PLAYABLE_SOUND_EXT.test(segment);
}

/** The file name at the end of an href, without query or fragment. */
export const assetName = (href) => href.split('?')[0].split('#')[0].split('/').pop() || null;

/** The `media/<name>` part of a saved-asset reference, or null for a web asset. */
export const savedAssetName = (src) => src.match(/^\.?\/?media\/(.+)$/)?.[1] ?? null;

/**
 * Stamp every asset's stored reference into `data-href` and point saved ones
 * (`./media/<name>`) at the API. Pictures and sound alike.
 */
export function rewriteMedia(root, docPath) {
  root.querySelectorAll('img[src], audio[src], source[src]').forEach((el) => {
    const src = el.getAttribute('src') || '';
    el.setAttribute('data-href', src);
    const name = savedAssetName(src);
    if (name) el.setAttribute('src', mediaFileUrl(docPath, name));
  });
  root.querySelectorAll('a[href]').forEach((el) => {
    const href = el.getAttribute('href') || '';
    if (isSoundLink(href)) el.setAttribute('data-href', href);
  });
}

const BESIDE_MAX_WIDTH = 160;
const ACTION_CLEARANCE = 240;
const EDGE = 8;

/**
 * Where the save button goes: on a picture's corner, beside a sound link (too
 * narrow to sit on), and back to the corner near the right edge of the window.
 * `rect` and `viewportWidth` are both in shell-layout space.
 */
export function actionPosition(rect, viewportWidth = layoutViewport().width) {
  const beside = rect.width < BESIDE_MAX_WIDTH && rect.right + ACTION_CLEARANCE < viewportWidth;
  return beside
    ? { top: Math.max(EDGE, rect.top - 2), left: rect.right + EDGE }
    : { top: Math.max(EDGE, rect.top + EDGE), right: Math.max(EDGE, viewportWidth - rect.right + EDGE) };
}

/**
 * The asset under the pointer as the card form needs to hear about it, or null.
 * An inline `data:` picture is nothing: it lives in the clip body and has no URL.
 */
export function mediaHitFor(el) {
  const isAudio = el.tagName === 'AUDIO';
  const isSound = isAudio || (el.tagName === 'A' && !!el.getAttribute('data-href'));
  const holder = isAudio ? (el.getAttribute('data-href') ? el : el.querySelector('source[data-href]')) : el;
  const href = holder?.getAttribute('data-href') || '';
  if (!href || /^data:/i.test(href)) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    href,
    kind: isSound ? 'audio' : 'image',
    name: assetName(href),
    alt: el.getAttribute('alt')?.trim() || null,
    rect: toLayoutRect(rect),
  };
}
