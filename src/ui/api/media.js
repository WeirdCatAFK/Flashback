import { upload, getBaseUrl, appendToken } from "./client.js";

const MEDIA_SLOTS = ["front_img", "back_img", "front_sound", "back_sound"];

export const mediaFileSrc = (docPath, ref) => {
  if (!ref) return null;
  if (/^[a-f0-9]{64}$/i.test(ref)) {
    return appendToken(
      `${getBaseUrl()}/api/media?hash=${encodeURIComponent(ref)}`,
    );
  }
  const name = ref.replace(/^\.?\/?media\//, "");
  return appendToken(
    `${getBaseUrl()}/api/media/file?docPath=${encodeURIComponent(docPath || "")}&name=${encodeURIComponent(name)}`,
  );
};

export const mediaFileUrl = (docPath, name) =>
  appendToken(
    `${getBaseUrl()}/api/media/file?docPath=${encodeURIComponent(docPath)}&name=${encodeURIComponent(name)}`,
  );

export const createVanillaCard = (docPath, card, mediaFiles = {}) => {
  const fd = new FormData();
  fd.append("docPath", docPath);
  fd.append("card", JSON.stringify(card));
  for (const slot of MEDIA_SLOTS) {
    const file = mediaFiles[slot];
    if (file) fd.append(slot, file, file.name);
  }
  return upload("/api/media/vanilla", fd);
};
