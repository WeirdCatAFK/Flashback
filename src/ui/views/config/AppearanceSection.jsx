import { useState } from 'react';
import Stepper from '../../components/base/Stepper';
import Toggle from '../../components/base/Toggle';
import { treeIconsOn, setTreeIcons } from '../../utils/treeIcons.js';
import { coverMotionOn, setCoverMotion } from '../../utils/coverMotion.js';
import { themeLabel } from '../../utils/themes';
import { useT } from '../../translations/index';
import { LanguagePicker } from '../../translations/components.jsx';
import ConfigRow from './ConfigRow';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const stepZoom = (z, d) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat((z + d).toFixed(1))));

export default function AppearanceSection({ theme, onThemeChange, allThemes, zoom, onZoomChange, onOpenEditor }) {
  const { t } = useT();
  const [treeIcons, setTreeIconsState] = useState(treeIconsOn);
  const [coverMotion, setCoverMotionState] = useState(coverMotionOn);
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

      <ConfigRow id="coverMotion">
        <Toggle checked={coverMotion} onChange={(on) => { setCoverMotion(on); setCoverMotionState(on); }} ariaLabel={t('Moving covers')} />
      </ConfigRow>
    </>
  );
}
