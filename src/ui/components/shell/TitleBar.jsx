/**
 * TitleBar — the frameless-window drag region: "Flashback │ vault ▾ │ screen",
 * with the role badge beside the vault when connected, the Ctrl+K search button
 * (App only), and the window controls. The screen's name lives here so a tool
 * screen need not repeat it as a heading. Styles live in App.css.
 */

import { windowMinimize, windowMaximize, windowClose } from '../../api/desktop';
import { useT } from '../../translations/index';
import VaultSwitcher from '../vault/VaultSwitcher.jsx';
import RoleBadge from '../account/RoleBadge.jsx';

function WindowControls() {
  const { t } = useT();
  return (
    <div id="window-controls">
      <button type="button" className="wc-btn wc-minimize" title={t('Minimize')} aria-label={t('Minimize')}
        onClick={windowMinimize}>
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button type="button" className="wc-btn wc-maximize" title={t('Maximize')} aria-label={t('Maximize')}
        onClick={windowMaximize}>
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><rect x=".5" y=".5" width="8" height="8" stroke="currentColor"/></svg>
      </button>
      <button type="button" className="wc-btn wc-close" title={t('Close')} aria-label={t('Close')}
        onClick={windowClose}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/>
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      </button>
    </div>
  );
}

export default function TitleBar({ onSearch, connection, onManageVaults, screen }) {
  const { t } = useT();
  return (
    <div id="title-bar">
      <div id="title-bar-left">
        <span id="app-title">Flashback</span>
        {connection && (
          <>
            <span className="title-bar-sep" aria-hidden="true" />
            <VaultSwitcher connection={connection} onManageVaults={onManageVaults} />
            <RoleBadge connection={connection} />
          </>
        )}
        {screen && (
          <>
            <span className="title-bar-sep" aria-hidden="true" />
            <span id="title-screen" aria-live="polite">{screen}</span>
          </>
        )}
      </div>
      {onSearch && (
        <button type="button" id="search-btn" title={t('Search (Ctrl+K)')} aria-label={t('Search')} onClick={onSearch}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <kbd>Ctrl+K</kbd>
        </button>
      )}
      <WindowControls />
    </div>
  );
}
