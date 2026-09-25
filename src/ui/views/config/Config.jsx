/**
 * Config — every setting, split into short sections reached from an index on the left,
 * instead of one long scroll. Each index entry sums its section up in a line (the
 * scheduler and the daily limit, the theme and the language, who you are…), so most
 * questions are answered before a section is opened. "Search settings" (Ctrl+F while the
 * screen shows) finds any setting by name, across sections, as the rows themselves.
 *
 * The catalogue of rows and the search are settings.js; a section is a component whose
 * rows (ConfigRow) render only while the search matches them (rowsContext.js), so one
 * component serves its own page and a result list. The local server keeps its Save and
 * restart; everything else applies as it changes, as before. The theme editor is a page
 * of its own under Appearance.
 *
 * Hooks: useConfig (config.json), useSrsPrefs / useDiaryPref (vault-scoped preferences),
 * useIdentity, useAppUpdates.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import useKeybindings from '../../hooks/useKeybindings';
import { isDesktop } from '../../api/desktop';
import { getPref, setPref } from '../../prefs.js';
import { useT, LOCALE_OPTIONS } from '../../translations/index';
import { loadCustomThemes } from '../../customThemes';
import { themeLabel } from '../../themes';
import { diaryLabels, isSharedVault } from '../../diaryLabels.js';
import { SECTIONS, sectionName, settingRows, searchSettings, hitsBySection, changedShortcuts, diaryAccessOf } from './settings.js';
import { RowsContext } from './rowsContext.js';
import useConfig from './useConfig';
import useSrsPrefs, { useDiaryPref } from './useSrsPrefs';
import useIdentity from './useIdentity';
import useAppUpdates from './useAppUpdates';
import StudySection from './StudySection';
import AppearanceSection from './AppearanceSection';
import KeyboardSection from './KeyboardSection';
import IdentitySection from './IdentitySection';
import AssistantSection from './AssistantSection';
import ServerSection from './ServerSection';
import AboutSection from './AboutSection';
import ThemeEditor from './ThemeEditor';
import './Config.css';

const SECTION_PREF = 'fb-config-section';
const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };

export default function ConfigView({
  isActive = true,
  theme,
  onThemeChange,
  allThemes,
  onCustomThemesChange,
  onReplayTour,
  connection,
  zoom = 1,
  onZoomChange,
}) {
  const { t, tp, locale, formatNumber } = useT();
  const desktop = isDesktop();
  const shared = isSharedVault(connection);
  const studyRecord = diaryLabels(t, shared);
  const cfg = useConfig();
  const prefs = useSrsPrefs();
  const diary = useDiaryPref();
  const identity = useIdentity(connection);
  const updates = useAppUpdates();
  const keymap = useKeybindings();
  const [current, setCurrent] = useState(() => {
    const stored = getPref(SECTION_PREF);
    return SECTIONS.some((s) => s.id === stored) ? stored : 'study';
  });
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const searchRef = useRef(null);
  const paneRef = useRef(null);

  const diaryAccess = diaryAccessOf(cfg.form?.mcpDiaryAccess);
  const ctx = { fsrs: prefs.algorithm === 'fsrs', desktop, customPath: !!cfg.form?.isCustomPath, shared, studyRecord };
  const rows = settingRows(t, ctx);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const hits = query.trim() ? searchSettings(rows, query) : null;

  useEffect(() => {
    if (!isActive) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  const go = (id) => {
    setCurrent(id);
    setQuery('');
    setEditorOpen(false);
    setPref(SECTION_PREF, id);
    if (paneRef.current) paneRef.current.scrollTop = 0;
  };

  const localeName = LOCALE_OPTIONS.find((o) => o.code === locale)?.name ?? locale;
  const shortcutsChanged = changedShortcuts(keymap, t);
  const summary = {
    study: `${ALGO_LABEL[prefs.algorithm] ?? prefs.algorithm} · ${tp('{n} new a day', '{n} new a day', prefs.maxNew, { n: formatNumber(prefs.maxNew) })}`,
    look: `${themeLabel(t, theme ?? 'light-workbench')} · ${localeName}`,
    keys: shortcutsChanged ? tp('{n} changed', '{n} changed', shortcutsChanged) : t('Defaults'),
    you: identity.effective?.name || identity.global.name || '—',
    ai: !desktop ? t('Desktop app only')
      : diaryAccess === 'full' ? t('Reads the diary')
        : diaryAccess === 'summaries' ? t('Reads summaries')
          : t('Diary private'),
    server: !desktop ? t('Desktop app only')
      : `${t('port {port}', { port: cfg.form?.port ?? cfg.config?.port ?? '—' })}${cfg.restartPending ? ` · ${t('restart')}` : cfg.isDirty ? ` · ${t('unsaved')}` : ''}`,
    about: desktop ? `${updates.version ? `v${updates.version}` : '—'}${updates.waiting ? ` · ${t('update')}` : ''}` : t('Welcome tour'),
  };

  /** A section's rows; the desktop-only ones say so outside the desktop app, and wait for config.json within it. */
  const body = (id) => {
    const needsConfig = id === 'ai' || id === 'server';
    if (needsConfig && !desktop) return <p className="cf-lede">{t('This is set in the desktop app.')}</p>;
    if (needsConfig && cfg.loading) return <LoadingState message={t('Loading settings…')} />;
    if (needsConfig && cfg.error) return <ErrorState error={cfg.error} title={t("Couldn't load settings")} />;
    switch (id) {
      case 'study': return <StudySection prefs={prefs} diary={diary} studyRecord={studyRecord} />;
      case 'look': return (
        <AppearanceSection theme={theme} onThemeChange={onThemeChange} allThemes={allThemes}
          zoom={zoom} onZoomChange={onZoomChange} onOpenEditor={() => setEditorOpen(true)} />
      );
      case 'keys': return <KeyboardSection />;
      case 'you': return <IdentitySection identity={identity} />;
      case 'ai': return <AssistantSection diaryAccess={diaryAccess} onDiaryAccess={(mode) => cfg.writeField('mcpDiaryAccess', mode)} />;
      case 'server': return <ServerSection cfg={cfg} />;
      case 'about': return <AboutSection desktop={desktop} updates={updates} onReplayTour={onReplayTour} />;
      default: return null;
    }
  };

  const scopeOf = (id) => {
    const scope = SECTIONS.find((s) => s.id === id)?.scope;
    return scope === 'vault' ? t('for this vault') : scope === 'computer' ? t('for this computer') : null;
  };

  let pane;
  if (hits) {
    const groups = hitsBySection(hits);
    pane = groups.length ? groups.map((g) => (
      <section key={g.section} className="cf-hits" aria-label={sectionName(g.section, t)}>
        <button type="button" className="cf-hits__section" onClick={() => go(g.section)}>
          {sectionName(g.section, t)} <span aria-hidden="true">›</span>
        </button>
        <RowsContext.Provider value={{ rows: byId, only: g.ids }}>{body(g.section)}</RowsContext.Provider>
      </section>
    )) : <p className="cf-none">{t('No setting matches “{query}”.', { query: query.trim() })}</p>;
  } else if (current === 'look' && editorOpen) {
    pane = (
      <ThemeEditor onSaved={() => onCustomThemesChange(loadCustomThemes())} onThemeChange={onThemeChange}
        currentTheme={theme} onClose={() => setEditorOpen(false)} />
    );
  } else {
    pane = (
      <>
        <header className="cf-head">
          <h2>{sectionName(current, t)}</h2>
          {scopeOf(current) && <span className="cf-scope">{scopeOf(current)}</span>}
        </header>
        <RowsContext.Provider value={{ rows: byId, only: null }}>{body(current)}</RowsContext.Provider>
      </>
    );
  }

  return (
    <div className="cf-view">
      <aside className="cf-side" aria-label={t('Settings')}>
        <div className="cf-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
          </svg>
          <input ref={searchRef} type="search" placeholder={t('Search settings')} aria-label={t('Search settings')} autoComplete="off"
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
        </div>
        <nav className="cf-index" aria-label={t('Settings sections')}>
          {SECTIONS.map(({ id }) => (
            <button key={id} type="button" className="cf-entry" aria-current={!hits && id === current ? 'page' : undefined} onClick={() => go(id)}>
              <span>{sectionName(id, t)}</span>
              <small>{summary[id]}</small>
            </button>
          ))}
        </nav>
      </aside>
      <div className="cf-pane" ref={paneRef}>
        <div className="cf-pane__inner">{pane}</div>
      </div>
    </div>
  );
}
