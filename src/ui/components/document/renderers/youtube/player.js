/**
 * The plain-data side of the YouTube renderer: the video record read out of a
 * `.youtube` file, the postMessage protocol spoken with the embed page, and a
 * timestamp marker's shape.
 */

import { generateHighlightId } from '../highlightId.js';
import { formatTime } from './time.js';

export const CMD_TYPE = 'fb-yt-cmd';
export const EVENT_TYPE = 'fb-yt';

/** The video facts from a `.youtube` body and its sidecar, body winning. */
export function parseVideoMeta(content, metadata) {
  let body = {};
  try { body = JSON.parse(content || '{}'); } catch { body = {}; }
  return {
    videoId: body.videoId || metadata?.source?.videoId || '',
    title: body.title || metadata?.source?.title || '',
    author: body.author || '',
    url: body.url || metadata?.source?.url || '',
    thumbnailUrl: body.thumbnailUrl || '',
  };
}

/** The transcript cues stored in the sidecar, if any. */
export function transcriptFrom(metadata) {
  const tr = metadata?.source?.transcript;
  const cues = Array.isArray(tr) ? tr : [];
  return { cues, info: cues.length ? { cues: cues.length, ...(metadata?.source?.transcriptMeta ?? {}) } : null };
}

/** A command message for the embed page. */
export const playerCommand = (cmd, seconds) => ({ type: CMD_TYPE, cmd, ...(seconds != null ? { seconds } : {}) });

/** Whether a window message is an event from this iframe's player. */
export const isPlayerEvent = (ev, iframe) =>
  !!iframe && ev.source === iframe.contentWindow && ev.data?.type === EVENT_TYPE;

/** YouTube's error codes 101/150 mean the owner disabled embedding; anything else is unavailability. */
export const isEmbedBlocked = (code) => code === 101 || code === 150;

/** A `video_timestamp` highlight at `seconds`, labelled by the cue text or the time. */
export function newMarker(seconds, label) {
  const now = new Date().toISOString();
  return {
    id: generateHighlightId(), color: 'amber', type: 'video_timestamp', start: seconds, end: seconds,
    text: label ? `${label.trim()}` : `@ ${formatTime(seconds)}`,
    createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
  };
}

/** `markers` plus `marker`, kept in time order. */
export const withMarker = (markers, marker) => [...markers, marker].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

/** A reading position from the player's progress event. */
export const progressRecord = (seconds, duration) => ({
  unit: 'segment',
  position: { seconds },
  percent: duration > 0 ? Math.min(1, seconds / duration) : null,
  total: duration || null,
});
