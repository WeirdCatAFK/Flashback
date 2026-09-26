/**
 * VideoBar — the slim bar under the player that stays at the top of the page once the
 * player has scrolled away: play or pause, where the video is on a thin line with every
 * moment as a tick in its highlight colour, and the time. "Back to now" appears when the
 * passage being said has been scrolled out of view.
 */

import { useT } from '../../../../translations/index';
import { hlColor } from '../../finderRows.js';
import { isBlankNote } from './transcript.js';
import { formatTime } from './time.js';

const SEEK_STEP = 5;

function PlayIcon({ playing }) {
  return playing ? (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor"><path d="M5 3.2v9.6a.7.7 0 0 0 1.05.6l7.4-4.8a.7.7 0 0 0 0-1.2l-7.4-4.8A.7.7 0 0 0 5 3.2Z" /></svg>
  );
}

export default function VideoBar({ ready, playing, time, duration, moments, freshId, onToggle, onSeek, onJump, showNow, onBackToNow }) {
  const { t } = useT();
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const seekAt = (e) => {
    if (!duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width) onSeek(((e.clientX - r.left) / r.width) * duration);
  };
  return (
    <div className="yt-bar">
      <button type="button" className="yt-bar__toggle" onClick={onToggle} disabled={!ready} aria-label={playing ? t('Pause') : t('Play')} title={playing ? t('Pause') : t('Play')}>
        <PlayIcon playing={playing} />
      </button>
      <div
        className="yt-bar__track"
        role="slider"
        tabIndex={0}
        aria-label={t('Position in the video')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={t('{time} of {total}', { time: formatTime(time), total: formatTime(duration) })}
        onClick={(e) => { if (!e.target.closest('.yt-bar__tick')) seekAt(e); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            onSeek(Math.max(0, time + (e.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP)), { play: playing });
          }
        }}
      >
        <span className="yt-bar__rail" />
        <i className="yt-bar__watched" style={{ width: `${pct}%` }} />
        {duration > 0 && moments.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`yt-bar__tick${m.id === freshId ? ' is-fresh' : ''}`}
            style={{ left: `${Math.min(100, ((m.start ?? 0) / duration) * 100)}%`, '--hl': hlColor(m.color) }}
            aria-label={t('Moment at {time}', { time: formatTime(m.start ?? 0) })}
            title={isBlankNote(m.text) ? formatTime(m.start ?? 0) : `${formatTime(m.start ?? 0)} · ${m.text}`}
            onClick={() => onJump(m.id)}
          />
        ))}
        {duration > 0 && <i className="yt-bar__head" style={{ left: `${pct}%` }} />}
      </div>
      <span className="yt-bar__clock">{formatTime(time)}{duration > 0 ? ` / ${formatTime(duration)}` : ''}</span>
      {showNow && <button type="button" className="yt-bar__now" onClick={onBackToNow}>{t('Back to now')}</button>}
    </div>
  );
}
