/**
 * ConfigRow — one setting on one line: what it is on the left (its label, and a quieter
 * hint under it), the control on the right, a hairline between rows. The label and hint
 * come from the catalogue (settings.js) by `id`; `hint` replaces the catalogue's with a
 * live one. `stack` puts a wide control (the theme swatches, the MCP snippet) under its
 * label; `restart` flags a setting that applies after a restart. A row the current
 * search did not match renders nothing.
 */

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
