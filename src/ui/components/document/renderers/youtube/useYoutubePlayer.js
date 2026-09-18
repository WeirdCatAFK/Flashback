/**
 * The embedded player: the iframe, its ready/error state, the messages it sends
 * (ready, error, a mark request, progress) and the commands sent back (seek,
 * seekQuiet, mark). Resumes the saved position once the player is ready, without
 * starting playback.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useT } from '../../../../translations/index';
import { playerCommand, isPlayerEvent, isEmbedBlocked, progressRecord } from './player.js';

export default function useYoutubePlayer({ path, embedSrc, initialProgress, onProgress, progressRef, onMarkAt }) {
  const { t } = useT();
  const [playerReady, setPlayerReady] = useState(false);
  const [apiFailed, setApiFailed] = useState(false);
  const [playbackError, setPlaybackError] = useState(null);
  const iframeRef = useRef(null);
  const watchedRef = useRef(null);
  const resumedRef = useRef(false);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onMarkAtRef = useRef(onMarkAt);
  onMarkAtRef.current = onMarkAt;

  const postCmd = useCallback((cmd, seconds) => {
    iframeRef.current?.contentWindow?.postMessage(playerCommand(cmd, seconds), '*');
  }, []);

  useEffect(() => { resumedRef.current = false; setApiFailed(false); }, [path]);

  useEffect(() => {
    if (!embedSrc) return undefined;
    setPlayerReady(false);
    setPlaybackError(null);
    const onMessage = (ev) => {
      if (!isPlayerEvent(ev, iframeRef.current)) return;
      const d = ev.data;
      if (d.event === 'ready') {
        setPlayerReady(true);
        setPlaybackError(null);
      } else if (d.event === 'error') {
        setPlaybackError({
          code: d.code,
          message: isEmbedBlocked(d.code)
            ? t('This video can’t be played in an embed (the owner disabled embedding, or it’s age-restricted). Open it on YouTube instead.')
            : t('This video is unavailable (it may be private or removed).'),
        });
      } else if (d.event === 'markAt') {
        onMarkAtRef.current?.(d.seconds || 0);
      } else if (d.event === 'progressAt') {
        const seconds = d.seconds || 0;
        const duration = d.duration || 0;
        watchedRef.current = { seconds, duration };
        onProgressRef.current?.(path, progressRecord(seconds, duration));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embedSrc, path, t]);

  useEffect(() => {
    if (resumedRef.current || !playerReady || initialProgress === undefined) return;
    resumedRef.current = true;
    const seconds = initialProgress?.position?.seconds;
    if (seconds > 0) postCmd('seekQuiet', seconds);
  }, [playerReady, initialProgress, postCmd]);

  useEffect(() => {
    if (!progressRef) return undefined;
    progressRef.current = {
      goToStart: () => postCmd('seekQuiet', 0),
      currentPosition: () => (watchedRef.current ? progressRecord(watchedRef.current.seconds, watchedRef.current.duration) : null),
    };
    return () => { progressRef.current = null; };
  }, [progressRef, postCmd]);

  return {
    iframeRef,
    playerReady,
    apiFailed,
    playbackError,
    onIframeError: () => setApiFailed(true),
    seekTo: (seconds) => postCmd('seek', seconds),
    markMoment: () => { if (playerReady) postCmd('mark'); },
  };
}
