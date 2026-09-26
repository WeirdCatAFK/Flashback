/**
 * Embed URLs served by the API — the YouTube proxy page that carries the
 * player and its postMessage bridge, so the renderer never talks to youtube.com.
 */

import { getBaseUrl } from "./client.js";

/** The proxied player page for a video, or null before the client is initialised. */
export const youtubeEmbedUrl = (videoId) =>
  videoId && getBaseUrl()
    ? `${getBaseUrl()}/embed/youtube?v=${encodeURIComponent(videoId)}`
    : null;
