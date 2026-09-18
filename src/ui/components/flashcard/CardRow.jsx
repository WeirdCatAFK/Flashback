/**
 * CardRow — one flashcard as a list line: its level dot, the front (and the
 * graded answer underneath), then whatever the list wants to say about it as
 * badges, and its actions. Used by the card browser, a deck's card list and the
 * document inspector, which used to each draw their own.
 *
 *   <CardRow level={2} front="…" back="…" badges={[{ label: 'Rule', tone: 'accent' }]}
 *            actions={<button className="btn-close" … />} onOpen={open} />
 *
 * `badges` is `[{ key?, label, tone?, title? }]`, tone one of
 * `muted` (default) | `accent` | `danger` | `hard` | `outline`. `layout="stack"`
 * puts the meta line under the text for narrow panels.
 */

import { useT } from '../../translations/index';
import './CardRow.css';

/** The level as a coloured dot: hue climbs from red at 0 to green at 6+. */
export function LevelDot({ level = 0 }) {
  const { t } = useT();
  const hue = Math.min(level * 20, 120);
  return (
    <span className="card-row__level" style={{ background: `hsl(${hue},60%,45%)` }} title={t('Level {n}', { n: level })}>
      {level}
    </span>
  );
}

export default function CardRow({
  level = 0,
  front,
  back,
  badges = [],
  actions,
  tags,
  onOpen,
  layout = 'row',
  highlighted = false,
  className = '',
  title,
}) {
  const { t } = useT();
  const interactive = typeof onOpen === 'function';
  const classes = [
    'card-row',
    layout === 'stack' ? 'card-row--stack' : '',
    highlighted ? 'card-row--highlighted' : '',
    interactive ? 'card-row--interactive' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={title}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      } : undefined}
    >
      <LevelDot level={level} />
      <div className="card-row__body">
        <div className="card-row__front">{front || t('(untitled)')}</div>
        {back && <div className="card-row__back">{back}</div>}
        {tags?.length > 0 && (
          <div className="card-row__tags">
            {tags.map((tag) => <span key={tag} className="chip chip--muted">{tag}</span>)}
          </div>
        )}
      </div>
      {(badges.length > 0 || actions) && (
        <div className="card-row__meta">
          {badges.map((b) => (
            <span key={b.key ?? b.label} className={`card-row__badge card-row__badge--${b.tone ?? 'muted'}`} title={b.title}>
              {b.label}
            </span>
          ))}
          {actions && <span className="card-row__actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
        </div>
      )}
    </div>
  );
}
