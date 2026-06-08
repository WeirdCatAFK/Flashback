import { upload, getBaseUrl } from './client.js';

const MEDIA_SLOTS = ['front_img', 'back_img', 'front_sound', 'back_sound'];

/**
 * Resolves a vanilla card media reference (e.g. "./media/front-1a2b.png", as
 * stored in vanillaData.media) to a streamable URL via GET /api/media/file.
 * Pass as <Flashcard resolveMedia> together with the card's document path.
 *
 * @param {string} docPath - relative path to the card's source document.
 * @param {string} ref - the stored media reference.
 * @returns {string|null}
 */
export const mediaFileSrc = (docPath, ref) => {
  if (!ref) return null;
  const name = ref.replace(/^\.?\/?media\//, '');
  return `${getBaseUrl()}/api/media/file?docPath=${encodeURIComponent(docPath)}&name=${encodeURIComponent(name)}`;
};

/**
 * Create a vanilla flashcard and attach its media in a single request — the
 * server assigns the globalHash and patches vanillaData.media, so the caller
 * never has to sequence create → read-back-hash → upload.
 *
 * @param {string} docPath - relative path to the parent document.
 * @param {object} card - the card object (front/back text, tags, category, …).
 * @param {{ front_img?: File, back_img?: File, front_sound?: File, back_sound?: File }} [mediaFiles]
 * @returns {Promise<{ ok: boolean, card: object }>}
 */
export const createVanillaCard = (docPath, card, mediaFiles = {}) => {
  const fd = new FormData();
  fd.append('docPath', docPath);
  fd.append('card', JSON.stringify(card));
  for (const slot of MEDIA_SLOTS) {
    const file = mediaFiles[slot];
    if (file) fd.append(slot, file, file.name);
  }
  return upload('/api/media/vanilla', fd);
};

