/**
 * AppearanceSection — this computer's look: the theme as swatches, the theme editor (its
 * own page, opened from here), the language, the zoom, and the file tree's icons.
 *
 * A swatch draws itself in its theme: it carries `data-theme`, and every theme, built-in
 * or custom, is a `[data-theme]` block of variables, so the swatch shows the theme's real
 * desk, card, accent and ink with no second list of colours to keep in step.
 */

import { useState } from 'react';
import Stepper from '../../components/base/Stepper';
import Toggle from '../../components/base/Toggle';
import { treeIconsOn, setTreeIcons } from '../../treeIcons.js';
import { themeLabel } from '../../themes';
import { useT } from '../../translations/index';
import { LanguagePicker } from '../../translations/components.jsx';
import ConfigRow from './ConfigRow';

/** Zoom moves in tenths, within the range Ctrl + and Ctrl − allow (App.jsx). */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const stepZoom = (z, d) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat((z + d).toFixed(1))));

export default function AppearanceSection({ theme, onThemeChange, allThemes, zoom, onZoomChange, onOpenEditor }) {
  const { t } = useT();
  const [treeIcons, setTreeIconsState] = useState(treeIconsOn);
  const current = theme ?? 'light-workbench';

  return (
    <>
      <ConfigRow id="theme" stack>
        <div className="cf-themes" role="radiogroup" aria-label={t('Theme')}>
          {allThemes.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={id === current} className="cf-theme" onClick={() => onThemeChange(id)}>
              <span className="cf-theme__swatch" data-theme={id} aria-hidden="true">
                <i className="cf-theme__card" />
                <i className="cf-theme__line" />
                <i className="cf-theme__accent" />
              </span>
              <span className="cf-theme__name">{themeLabel(t, id)}</span>
            </button>
          ))}
        </div>
      </ConfigRow>

      <ConfigRow id="themeEditor">
        <button type="button" className="btn btn--quiet btn--sm" onClick={onOpenEditor}>{t('Open the theme editor')}</button>
      </ConfigRow>

      <ConfigRow id="language" htmlFor="cf-locale">
        <LanguagePicker id="cf-locale" className="field field--sm cf-select" />
      </ConfigRow>

      {onZoomChange && (
        <ConfigRow id="zoom">
          <Stepper
            label={t('Zoom')}
            display={`${Math.round(zoom * 100)}%`}
            onDecrease={() => onZoomChange(stepZoom(zoom, -0.1))}
            onIncrease={() => onZoomChange(stepZoom(zoom, 0.1))}
            onValueClick={() => onZoomChange(1)}
            valueTitle={t('Back to 100%')}
            canDecrease={zoom > ZOOM_MIN}
            canIncrease={zoom < ZOOM_MAX}
          />
        </ConfigRow>
      )}

      <ConfigRow id="treeIcons">
        <Toggle checked={treeIcons} onChange={(on) => { setTreeIcons(on); setTreeIconsState(on); }} ariaLabel={t('Icons in the file tree')} />
      </ConfigRow>
    </>
  );
}
