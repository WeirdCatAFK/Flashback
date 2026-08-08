import { ramp } from '../../utils/chartRamp';
import { useT } from '../../translations';

/**
 * RetentionCurve — one card's predicted recall decaying from its last review out
 * past its due date.
 *
 * The math is entirely the server's (see access/orchestration/srs.js `_buildCurve`): this
 * component receives sampled { t, r } points and draws them, so the renderer holds
 * no scheduler knowledge and can't disagree with the Trainer about when a card is
 * due. What it *does* own is saying which of the two curves the user is looking at —
 * FSRS models memory directly, Leitner and SM-2 don't, and the caption says so
 * rather than letting one shape imply the same confidence as the other.
 */

const W = 640, H = 220;
const M = { t: 12, r: 12, b: 24, l: 38 };
const PW = W - M.l - M.r;
const PH = H - M.t - M.b;

const pct = (r) => `${Math.round(r * 100)}%`;
const days = (d) => (d >= 10 ? `${Math.round(d)}d` : `${Math.round(d * 10) / 10}d`);

export default function RetentionCurve({ curve }) {
  const { t } = useT();
  if (!curve || !curve.points?.length) return null;

  const { points, horizonDays, requestRetention, intervalDays, nowT, nowR, model } = curve;

  const x = (t) => M.l + (t / horizonDays) * PW;
  const y = (r) => M.t + (1 - r) * PH;

  const path = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.r).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  const area = `${path} L${x(last.t).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const dueX = intervalDays > 0 && intervalDays <= horizonDays ? x(intervalDays) : null;
  const nowX = nowT <= horizonDays ? x(nowT) : null;
  const overdue = nowT > intervalDays && intervalDays > 0;

  const summary = t(
    'Retention curve: about {now} estimated recall now, {target} target reached at {interval} after the last review.',
    { now: pct(nowR), target: pct(requestRetention), interval: days(intervalDays) }
  );

  return (
    <div className="cd-curve">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary}>
        {/* Gridlines + percent axis */}
        {[1, requestRetention, 0.5, 0].map((r) => (
          <g key={r}>
            <line
              x1={M.l} x2={W - M.r} y1={y(r)} y2={y(r)}
              stroke="var(--color-border)"
              strokeWidth="1"
              strokeDasharray={r === requestRetention ? '4 4' : undefined}
              opacity={r === requestRetention ? 1 : 0.5}
            />
            <text x={M.l - 6} y={y(r) + 4} textAnchor="end"
              fontSize="11" fill="var(--color-fg-secondary)">
              {pct(r)}
            </text>
          </g>
        ))}

        {/* Everything past the due date is borrowed time. */}
        {overdue && dueX !== null && (
          <rect
            x={dueX} y={M.t} width={Math.max(0, (nowX ?? W - M.r) - dueX)} height={PH}
            fill="color-mix(in srgb, var(--color-review-again) 12%, transparent)"
          />
        )}

        <path d={area} fill={ramp(12)} />
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        >
          <title>{summary}</title>
        </path>

        {dueX !== null && (
          <g>
            <line x1={dueX} x2={dueX} y1={M.t} y2={M.t + PH}
              stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={dueX} y={H - 8} textAnchor="middle"
              fontSize="11" fill="var(--color-fg-secondary)">
              {t('due · {interval}', { interval: days(intervalDays) })}
            </text>
          </g>
        )}

        {nowX !== null && (
          <g>
            <line x1={nowX} x2={nowX} y1={y(nowR)} y2={M.t + PH}
              stroke="var(--color-accent)" strokeWidth="1" opacity="0.4" />
            <circle cx={nowX} cy={y(nowR)} r="4" fill="var(--color-accent)">
              <title>{t('Now — about {now} estimated recall', { now: pct(nowR) })}</title>
            </circle>
          </g>
        )}

        <text x={M.l} y={H - 8} fontSize="11" fill="var(--color-fg-secondary)">
          {t('last review')}
        </text>
      </svg>

      <p className="cd-curve-caption">
        {model === 'fsrs' ? (
          t('Modelled from this card’s FSRS stability ({stability}) using your vault’s weights.',
            { stability: days(curve.stabilityDays) })
        ) : (
          <>
            <strong>{t('Approximation.')}</strong>{' '}
            {t('This scheduler has no memory model — the curve assumes its {interval} interval is where recall falls to {target}.',
              { interval: days(intervalDays), target: pct(requestRetention) })}
          </>
        )}
      </p>
    </div>
  );
}
