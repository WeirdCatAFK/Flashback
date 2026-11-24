import { mediaFileUrl } from '../../../../api/media';
import { toLayoutRect, layoutViewport } from '../../../../utils/uiZoom';

const PLAYABLE_SOUND_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)(\?|#|$)/i;
export function isSoundLink(href) {
  if (!href) return false;
  const segment = href.split('?')[0].split('#')[0].split('/').pop() || '';
  if (segment.includes(':')) return false;
  return PLAYABLE_SOUND_EXT.test(segment);
}

export const assetName = (href) => href.split('?')[0].split('#')[0].split('/').pop() || null;

const savedAssetName = (src) => src.match(/^\.?\/?media\/(.+)$/)?.[1] ?? null;

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

export function actionPosition(rect, viewportWidth = layoutViewport().width) {
  const beside = rect.width < BESIDE_MAX_WIDTH && rect.right + ACTION_CLEARANCE < viewportWidth;
  return beside
    ? { top: Math.max(EDGE, rect.top - 2), left: rect.right + EDGE }
    : { top: Math.max(EDGE, rect.top + EDGE), right: Math.max(EDGE, viewportWidth - rect.right + EDGE) };
}

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
