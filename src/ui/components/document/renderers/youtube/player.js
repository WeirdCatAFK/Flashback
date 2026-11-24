import { generateHighlightId } from '../highlightId.js';
import { formatTime } from './time.js';

const CMD_TYPE = 'fb-yt-cmd';
const EVENT_TYPE = 'fb-yt';

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

export function transcriptFrom(metadata) {
  const tr = metadata?.source?.transcript;
  const cues = Array.isArray(tr) ? tr : [];
  return { cues, info: cues.length ? { cues: cues.length, ...(metadata?.source?.transcriptMeta ?? {}) } : null };
}

export const playerCommand = (cmd, seconds) => ({ type: CMD_TYPE, cmd, ...(seconds != null ? { seconds } : {}) });

export const isPlayerEvent = (ev, iframe) =>
  !!iframe && ev.source === iframe.contentWindow && ev.data?.type === EVENT_TYPE;

export const isEmbedBlocked = (code) => code === 101 || code === 150;

export function newMarker(seconds, label) {
  const now = new Date().toISOString();
  return {
    id: generateHighlightId(), color: 'amber', type: 'video_timestamp', start: seconds, end: seconds,
    text: label ? `${label.trim()}` : `@ ${formatTime(seconds)}`,
    createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
  };
}

export const withMarker = (markers, marker) => [...markers, marker].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

export const progressRecord = (seconds, duration) => ({
  unit: 'segment',
  position: { seconds },
  percent: duration > 0 ? Math.min(1, seconds / duration) : null,
  total: duration || null,
});
