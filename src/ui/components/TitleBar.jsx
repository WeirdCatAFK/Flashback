/**
 * TitleBar — the frameless-window drag region with the app title and window
 * controls. App and Setup each hand-copied this markup; this is the shared
 * source. Pass `onSearch` to include the Ctrl+K search button (App only); omit it
 * for the bare title bar (Setup).
 *
 * Styles live in App.css (#title-bar, #search-btn, .wc-btn), loaded by the shell.
 */

import { useT } from '../translations';
import VaultSwitcher from './VaultSwitcher.jsx';

function WindowControls() {
  const { t } = useT();
  return (
    <div id="window-controls">
      <button type="button" className="wc-btn wc-minimize" title={t('Minimize')} aria-label={t('Minimize')}
        onClick={() => window.flashback?.windowMinimize()}>
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button type="button" className="wc-btn wc-maximize" title={t('Maximize')} aria-label={t('Maximize')}
        onClick={() => window.flashback?.windowMaximize()}>
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><rect x=".5" y=".5" width="8" height="8" stroke="currentColor"/></svg>
      </button>
      <button type="button" className="wc-btn wc-close" title={t('Close')} aria-label={t('Close')}
        onClick={() => window.flashback?.windowClose()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/>
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      </button>
    </div>
  );
}

export default function TitleBar({ onSearch, connection, onManageVaults }) {
  const { t } = useT();
  return (
    <div id="title-bar">
      {/* The product name always leads — it is what the window is, and it does not change.
          The active vault sits beside it, separated, because it is the part that DOES
          change and has to be visible at all times: separating vaults is the entire point
          of having them. Setup renders this bar with no connection and shows the name
          alone. "Flashback" is a proper noun and stays as-is in every language. */}
      <div id="title-bar-left">
        <span id="app-title">Flashback</span>
        {connection && (
          <>
            <span id="title-bar-sep" aria-hidden="true" />
            <VaultSwitcher connection={connection} onManageVaults={onManageVaults} />
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
