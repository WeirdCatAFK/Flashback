import { useT } from '../../translations/index';
import { useRows } from './rowsContext.js';

export default function ConfigRow({ id, htmlFor, hint, stack = false, restart = false, children }) {
  const { t } = useT();
  const { rows, only } = useRows();
  const row = rows.get(id);
  if (!row || (only && !only.has(id))) return null;
  const note = hint ?? row.hint;
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={`cf-row${stack ? ' is-stack' : ''}`}>
      <div className="cf-label">
        <Label className="cf-label__name" htmlFor={htmlFor}>
          {row.label}
          {restart && <span className="cf-flag" title={t('Takes effect after a restart')}>{t('restart')}</span>}
        </Label>
        {note && <small>{note}</small>}
      </div>
      <div className="cf-control">{children}</div>
    </div>
  );
}
