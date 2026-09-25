/**
 * The embedded player: the iframe, its ready/error state, the messages it sends
 * (ready, error, a mark request, progress, and the clock — where it is and whether it
 * is playing) and the commands sent back (seek, seekQuiet, mark, play, pause).
 * Resumes the saved position once the player is ready, without starting playback.
 * The clock is for display: `time` moves as soon as a seek is asked for, and the embed
 * page reports it twice a second while playing. An embed page from an older server
 * sends no clock and no play state, so it falls back to the five-second progress
 * reports, which it sends only while playing: a report means "playing", and a silence
 * longer than the gap between reports means it stopped.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useT } from '../../../../translations/index';
import { playerCommand, isPlayerEvent, isEmbedBlocked, progressRecord } from './player.js';

/** How long without a clock (twice a second) or progress report (every 5 s) before playback counts as stopped. */
const TIME_SILENCE = 1500;
const PROGRESS_SILENCE = 6500;

export default function useYoutubePlayer({ path, embedSrc, initialProgress, onProgress, progressRef, onMarkAt }) {
  const { t } = useT();
  const [playerReady, setPlayerReady] = useState(false);
  const [apiFailed, setApiFailed] = useState(false);
  const [playbackError, setPlaybackError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(initialProgress?.position?.seconds ?? 0);
  const [duration, setDuration] = useState(initialProgress?.total ?? 0);
  const iframeRef = useRef(null);
  const watchedRef = useRef(null);
  const quietTimerRef = useRef(0);
  const statesHeardRef = useRef(false);
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
    setPlaying(false);
    statesHeardRef.current = false;
    const onMessage = (ev) => {
      if (!isPlayerEvent(ev, iframeRef.current)) return;
      const d = ev.data;
      if (d.event === 'ready') {
        setPlayerReady(true);
        setPlaybackError(null);
        if (d.duration) setDuration(d.duration);
      } else if (d.event === 'state') {
        statesHeardRef.current = true;
        clearTimeout(quietTimerRef.current);
        setPlaying(!!d.playing);
      } else if (d.event === 'time') {
        setTime(d.seconds || 0);
        if (d.duration) setDuration(d.duration);
        heardPlaying(TIME_SILENCE);
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
        setTime(seconds);
        if (duration) setDuration(duration);
        heardPlaying(PROGRESS_SILENCE);
        onProgressRef.current?.(path, progressRecord(seconds, duration));
      }
    };
    /**
     * From a page that reports no play state: a clock or progress report only comes while
     * playing, and silence past `ms` means it stopped. A page that does report state is
     * believed instead — it sends one last clock tick as it pauses.
     */
    const heardPlaying = (ms) => {
      if (statesHeardRef.current) return;
      setPlaying(true);
      clearTimeout(quietTimerRef.current);
      quietTimerRef.current = setTimeout(() => setPlaying(false), ms);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(quietTimerRef.current); };
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
    playing,
    time,
    duration,
    /** Jumps there and plays, unless `play` is false. */
    seekTo: (seconds, { play = true } = {}) => { setTime(seconds); postCmd(play ? 'seek' : 'seekQuiet', seconds); },
    togglePlay: () => postCmd(playing ? 'pause' : 'play'),
    markMoment: () => { if (playerReady) postCmd('mark'); },
  };
}
