import { keybindingActions, fixedShortcutGroups } from '../../utils/keybindings.js';

export const SECTIONS = [
  { id: 'study', scope: 'vault' },
  { id: 'look', scope: 'computer' },
  { id: 'keys', scope: 'computer' },
  { id: 'you', scope: 'computer' },
  { id: 'ai', scope: 'computer' },
  { id: 'server', scope: 'computer' },
  { id: 'about', scope: null },
];

export function sectionName(id, t) {
  switch (id) {
    case 'study': return t('Study');
    case 'look': return t('Appearance');
    case 'keys': return t('Keyboard');
    case 'you': return t('You');
    case 'ai': return t('AI assistant');
    case 'server': return t('Local server');
    case 'about': return t('About');
    default: return id;
  }
}

export function settingRows(t, ctx = {}) {
  const rows = [];
  const add = (section, id, label, hint = '', extra = '') => rows.push({ id, section, label, hint, words: `${label} ${hint} ${extra}`.toLowerCase() });

  add('study', 'scheduler', t('Scheduler'), t('How the gap before a card’s next review is worked out.'), 'srs algorithm leitner sm-2 sm2 fsrs');
  if (ctx.fsrs) {
    add('study', 'retention', t('Desired retention'), t('Higher means more reviews and stronger recall; lower, fewer reviews. 90% is a good default.'), 'fsrs');
    add('study', 'optimize', t('Fit to your reviews'), t('Fit the memory model to your own review history for more accurate scheduling.'), 'fsrs optimize parameters weights');
  }
  add('study', 'order', t('Card order'), t('The order the Trainer shows due cards in.'), 'interleaved shuffled priority trainer');
  add('study', 'maxNew', t('New cards a day'), t('The Trainer starts each day from this; you can change it for a session there.'), 'limit per day');
  add('study', 'diary', ctx.studyRecord?.prefLabel ?? t('Study diary'), ctx.studyRecord?.prefHint ?? '', 'diary logs summary record');

  add('look', 'theme', t('Theme'), t('The whole app follows it, cards included.'), 'dark light colours colors focus lamp');
  add('look', 'themeEditor', t('Theme editor'), t('Make your own theme, or change the colours of one you made. Saved themes appear above.'), 'custom colours colors json import export');
  add('look', 'language', t('Language'), t('Interface language.'), 'locale translation');
  add('look', 'zoom', t('Zoom'), t('Also Ctrl + and Ctrl −; Ctrl 0 resets.'), 'size scale text');
  add('look', 'treeIcons', t('Icons in the file tree'), t('A small icon for each document and folder in the Documents tree.'), 'file tree icons');
  add('look', 'coverMotion', t('Moving covers'), t('Some drawn covers move slowly: a star turns, a figure draws itself. Off keeps every cover still and does no drawing work.'), 'cover animation motion animated');

  for (const group of keybindingActions(t)) {
    for (const a of group.actions) add('keys', `key:${a.id}`, a.label, '', `${group.group} shortcut key`);
  }
  for (const group of fixedShortcutGroups(t)) {
    group.shortcuts.forEach((s, i) => add('keys', `fixed:${group.group}:${i}`, s.label, '', `${group.group} shortcut key`));
  }

  add('you', 'name', t('Name'), '', 'identity author');
  add('you', 'email', t('Email'), '', 'identity author');
  add('you', 'override', t('A different identity in this vault'), t('A work address on a work vault, say. Kept for this vault only.'), 'override vault identity');

  if (ctx.desktop) {
    add('ai', 'mcp', t('Connect an assistant'), t('Paste this into the assistant’s settings; Flashback needs to be running.'), 'mcp claude config token');
    add('ai', 'diaryAccess', t('What assistants may read from your diary'),
      t('Summaries are review counts, pass rates and streaks; entries are anything you wrote. This governs Flashback’s assistant only: one that can run commands on this computer can read the files anyway.'),
      'mcp diary logs privacy access');

    add('server', 'vault', t('Active vault'), t('Switch vaults from the title bar.'), 'vault');
    add('server', 'port', t('Port'), '', 'api network restart');
    add('server', 'host', t('Host'), '', 'api network localhost restart');
    add('server', 'logFormat', t('Log format'), '', 'logs restart');
    if (ctx.customPath) add('server', 'workspacePath', t('Workspace path'), '', 'folder location');

    add('about', 'version', t('Version'), '', 'release');
    add('about', 'updates', t('Updates'), t('Flashback checks for updates and asks before downloading anything.'), 'update version release');
  }
  add('about', 'tour', t('Welcome tour'), t('The guided tour of Flashback’s features.'), 'getting started onboarding help');
  return rows;
}

const wordsOf = (text) => text.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);

export function searchSettings(rows, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return rows.filter((r) => {
    const words = wordsOf(r.words);
    return terms.every((term) => words.some((w) => w.startsWith(term)));
  });
}

export function hitsBySection(hits) {
  return SECTIONS
    .map(({ id }) => ({ section: id, ids: new Set(hits.filter((h) => h.section === id).map((h) => h.id)) }))
    .filter((g) => g.ids.size > 0);
}

export function changedShortcuts(map, t = (s) => s) {
  return keybindingActions(t)
    .flatMap((g) => g.actions)
    .filter((a) => JSON.stringify(map?.[a.id] ?? a.default) !== JSON.stringify(a.default))
    .length;
}

export const diaryAccessOf = (value) => (value === true || value === 'full' ? 'full' : value === 'summaries' ? 'summaries' : 'none');
