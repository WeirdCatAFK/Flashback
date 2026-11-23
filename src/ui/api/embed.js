import { getBaseUrl } from "./client.js";

export const youtubeEmbedUrl = (videoId) =>
  videoId && getBaseUrl()
    ? `${getBaseUrl()}/embed/youtube?v=${encodeURIComponent(videoId)}`
    : null;
