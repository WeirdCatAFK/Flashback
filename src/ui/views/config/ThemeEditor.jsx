/**
 * ThemeEditor — the collapsible custom-theme editor: a name, one row per theme
 * variable (swatch + hex, or a text field for shadows and the editor scheme),
 * the JSON import/export panel, and the saved themes to reopen. State lives in
 * useThemeEditor.js.
 */

import { THEME_VARS, loadCustomThemes } from '../../customThemes';
import { useT } from '../../translations/index';
import useThemeEditor from './useThemeEditor';
import useThemeVarLabels from './useThemeVarLabels';

function VarInputs({ varKey, type, label, value, onChange }) {
  const { t } = useT();
  if (varKey === '--color-bg-editor') {
    return (
      <div className="theme-var-inputs">
        <button type="button" className={`btn btn--sm${value === 'dark' ? ' btn--accent-quiet' : ''}`} onClick={() => onChange('dark')}>{t('Dark')}</button>
        <button type="button" className={`btn btn--sm${value === 'light' ? ' btn--accent-quiet' : ''}`} onClick={() => onChange('light')}>{t('Light')}</button>
      </div>
    );
  }
  if (type === 'text') {
    return (
      <div className="theme-var-inputs">
        <input type="text" className="field field--sm theme-color-text theme-color-text--wide" aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} maxLength={180} />
      </div>
    );
  }
  return (
    <div className="theme-var-inputs">
      <input type="color" className="theme-color-swatch" aria-label={t('{label} color picker', { label })} value={value || '#000000'} onChange={(e) => onChange(e.target.value)} />
      <input type="text" className="field field--sm theme-color-text" aria-label={t('{label} hex code', { label })} value={value || ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} maxLength={25} />
    </div>
  );
}

export default function ThemeEditor({ onSaved, onThemeChange, currentTheme }) {
  const { t } = useT();
  const varLabels = useThemeVarLabels();
  const ed = useThemeEditor({ onSaved, onThemeChange, currentTheme });

  return (
    <div className="theme-editor">
      <button type="button" className="theme-editor-toggle" onClick={ed.toggleOpen} aria-expanded={ed.open}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`theme-editor-chevron${ed.open ? ' theme-editor-chevron--open' : ''}`}>
          <polyline points="4,2 9,6 4,10" />
        </svg>
        {t('Theme editor')}
      </button>

      {ed.open && (
        <>
          <div className="theme-editor-header">
            <input className="field theme-name-input" placeholder={t('Theme name…')} aria-label={t('Theme name')} value={ed.name} onChange={(e) => ed.setName(e.target.value)} spellCheck={false} />
            <div className="theme-editor-actions">
              <button type="button" className="btn btn--sm" onClick={ed.seedFromCurrent} title={t('Copy colors from the active theme')}>{t('Seed from current')}</button>
              <button type="button" className={`btn btn--sm${ed.previewing ? ' btn--accent-quiet' : ''}`} onClick={ed.togglePreview} title={t('Apply colors temporarily without saving')}>
                {ed.previewing ? t('Stop preview') : t('Preview')}
              </button>
              {ed.editing && <button type="button" className="btn btn--sm btn--danger-quiet" onClick={ed.remove}>{t('Delete')}</button>}
              <button type="button" className="btn btn--sm btn--primary" onClick={ed.save} disabled={!ed.canSave}>
                {ed.editing ? t('Update') : t('Save & apply')}
              </button>
            </div>
          </div>

          {ed.isNameTaken && (
            <p className="theme-editor-error">{t('“{name}” is a built-in theme name and cannot be overwritten.', { name: ed.name })}</p>
          )}

          <div className="theme-vars-grid">
            {THEME_VARS.map(({ key, label: fallback, type }) => {
              const label = varLabels[key] ?? fallback;
              return (
                <div key={key} className={`theme-var-row${type === 'text' ? ' theme-var-row--text' : ''}`}>
                  <label className="theme-var-label" title={key}>{label}</label>
                  <VarInputs varKey={key} type={type} label={label} value={ed.colors[key]} onChange={(v) => ed.setColor(key, v)} />
                </div>
              );
            })}
          </div>

          <div className="theme-text-panel">
            <div className="header-row theme-text-toolbar">
              <span className="eyebrow">JSON</span>
              <button type="button" className="btn btn--sm" onClick={ed.copyExport}>{t('Copy')}</button>
            </div>
            <textarea
              className="field theme-textarea"
              aria-label={t('Theme JSON')}
              value={ed.importText || ed.exportText}
              onChange={(e) => ed.setImportText(e.target.value)}
              spellCheck={false}
              rows={14}
            />
            {ed.importText && (
              <div className="theme-import-row">
                <button type="button" className="btn btn--sm btn--primary" onClick={ed.importTheme}>{t('Import')}</button>
                <button type="button" className="btn btn--sm" onClick={() => ed.setImportText('')}>{t('Cancel')}</button>
                {ed.importError && <span className="theme-editor-error">{ed.importError}</span>}
              </div>
            )}
          </div>

          <div className="theme-existing">
            <span className="eyebrow">{t('Edit existing:')}</span>
            {loadCustomThemes().map((custom) => (
              <button type="button" key={custom.name} className="btn btn--sm" onClick={() => ed.loadExisting(custom.name)}>{custom.name}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
