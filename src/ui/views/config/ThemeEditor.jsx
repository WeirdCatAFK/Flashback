/**
 * ThemeEditor — making a theme, on its own page under Appearance: a name, one row per
 * theme variable (a swatch and its hex, or a text field for shadows, or Dark/Light for the
 * editor scheme), the saved themes to reopen, and import/export as JSON folded away.
 * Going back to Appearance ends a preview. State lives in useThemeEditor.js.
 */

import { THEME_VARS, loadCustomThemes } from '../../customThemes';
import { useT } from '../../translations/index';
import useThemeEditor from './useThemeEditor';
import useThemeVarLabels from './useThemeVarLabels';

function VarInputs({ varKey, type, label, value, onChange }) {
  const { t } = useT();
  if (varKey === '--color-bg-editor') {
    return (
      <span className="segmented" role="group" aria-label={label}>
        <button type="button" className="segmented__option" aria-pressed={value === 'dark'} onClick={() => onChange('dark')}>{t('Dark')}</button>
        <button type="button" className="segmented__option" aria-pressed={value === 'light'} onClick={() => onChange('light')}>{t('Light')}</button>
      </span>
    );
  }
  if (type === 'text') {
    return <input type="text" className="field field--sm cf-var__text is-wide" aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} maxLength={180} />;
  }
  return (
    <>
      <input type="color" className="cf-var__swatch" aria-label={t('{label} color picker', { label })} value={value || '#000000'} onChange={(e) => onChange(e.target.value)} />
      <input type="text" className="field field--sm cf-var__text" aria-label={t('{label} hex code', { label })} value={value || ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} maxLength={25} />
    </>
  );
}

export default function ThemeEditor({ onSaved, onThemeChange, currentTheme, onClose }) {
  const { t } = useT();
  const varLabels = useThemeVarLabels();
  const ed = useThemeEditor({ onSaved, onThemeChange, currentTheme });
  const saved = loadCustomThemes();
  const back = () => { ed.leave(); onClose(); };

  return (
    <div className="cf-editor">
      <nav className="cf-crumb" aria-label={t('Breadcrumb')}>
        <button type="button" className="link-action" onClick={back}>{t('Appearance')}</button>
        <span aria-hidden="true">›</span>
        <span>{t('Theme editor')}</span>
      </nav>

      <div className="cf-editor__head">
        <input className="field field--sm cf-in" placeholder={t('Theme name')} aria-label={t('Theme name')} value={ed.name} onChange={(e) => ed.setName(e.target.value)} spellCheck={false} />
        <button type="button" className="btn btn--quiet btn--sm" onClick={ed.seedFromCurrent} title={t('Copy colors from the active theme')}>{t('Start from the current theme')}</button>
        <button type="button" className="btn btn--quiet btn--sm" aria-pressed={ed.previewing} onClick={ed.togglePreview} title={t('Apply colors temporarily without saving')}>
          {ed.previewing ? t('Stop preview') : t('Preview')}
        </button>
        {ed.editing && <button type="button" className="btn btn--danger-quiet btn--sm" onClick={ed.remove}>{t('Delete')}</button>}
        <button type="button" className="btn btn--quiet-accent btn--sm" onClick={ed.save} disabled={!ed.canSave}>
          {ed.editing ? t('Update') : t('Save and apply')}
        </button>
      </div>
      {ed.isNameTaken && <p className="cf-error">{t('“{name}” is a built-in theme name and cannot be overwritten.', { name: ed.name })}</p>}

      {saved.length > 0 && (
        <p className="cf-saved">
          <span>{t('Edit a saved theme:')}</span>
          {saved.map((custom) => (
            <button type="button" key={custom.name} className="link-action" aria-current={ed.editing === custom.name ? 'true' : undefined}
              onClick={() => ed.loadExisting(custom.name)}>{custom.name}</button>
          ))}
        </p>
      )}

      <div className="cf-vars">
        {THEME_VARS.map(({ key, label: fallback, type }) => {
          const label = varLabels[key] ?? fallback;
          return (
            <div key={key} className={`cf-var${type === 'text' ? ' is-text' : ''}`}>
              <span className="cf-var__label" title={key}>{label}</span>
              <span className="cf-var__inputs">
                <VarInputs varKey={key} type={type} label={label} value={ed.colors[key]} onChange={(v) => ed.setColor(key, v)} />
              </span>
            </div>
          );
        })}
      </div>

      <details className="cf-json">
        <summary>{t('Import or export as JSON')}</summary>
        <div className="cf-code">
          <div className="cf-code__head">
            <span className="cf-group__label">JSON</span>
            <button type="button" className="btn btn--quiet btn--sm" onClick={ed.copyExport}>{t('Copy')}</button>
          </div>
          <textarea className="cf-json__text" aria-label={t('Theme JSON')} value={ed.importText || ed.exportText}
            onChange={(e) => ed.setImportText(e.target.value)} spellCheck={false} rows={14} />
        </div>
        {ed.importText && (
          <div className="cf-actions">
            <button type="button" className="btn btn--quiet-accent btn--sm" onClick={ed.importTheme}>{t('Import')}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => ed.setImportText('')}>{t('Cancel')}</button>
            {ed.importError && <span className="cf-error">{ed.importError}</span>}
          </div>
        )}
      </details>
    </div>
  );
}
