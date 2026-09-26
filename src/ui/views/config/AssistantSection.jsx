/**
 * AssistantSection — connecting an AI assistant over MCP: the config snippet Electron main
 * mints (with this install's token), where it goes, and what the assistant may read from
 * the Diary. The diary setting is written straight through to config.json (`writeField`):
 * it is an authorization boundary the API reads from disk, so it never waits on a Save.
 */

import { useState, useEffect } from 'react';
import { getMcpConfig } from '../../api/desktop';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import ConfigRow from './ConfigRow';
import { useSearching } from './rowsContext.js';

/** How long "Copied" stays on the button. */
const COPIED_MS = 1800;

function Snippet() {
  const { t } = useT();
  const [state, setState] = useState({ data: null, error: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getMcpConfig()
      .then((data) => setState({ data, error: null }))
      .catch((error) => setState({ data: null, error }));
  }, []);

  const copy = () => {
    if (!state.data) return;
    navigator.clipboard.writeText(state.data.json);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  if (state.error) return <p className="cf-error">{state.error.message}</p>;
  return (
    <div className="cf-code">
      <div className="cf-code__head">
        <span className="cf-group__label">{t('MCP config')}</span>
        <button type="button" className="btn btn--quiet btn--sm" onClick={copy} disabled={!state.data}>{copied ? t('Copied') : t('Copy')}</button>
      </div>
      <pre aria-label={t('MCP server configuration JSON')}>{state.data?.json ?? t('Loading…')}</pre>
    </div>
  );
}

export default function AssistantSection({ diaryAccess, onDiaryAccess }) {
  const { t } = useT();
  const searching = useSearching();
  return (
    <>
      {!searching && (
        <p className="cf-lede">
          {t('Connect an AI assistant to this vault. It can search your notes, draft cards from a document and add them to a deck, from a conversation.')}
        </p>
      )}
      <ConfigRow id="mcp" stack>
        <div className="cf-mcp">
          <Snippet />
          <ul className="cf-where">
            <li>
              <b>Claude Desktop</b>{': '}
              <Rich text={t('paste it into {file}, then restart Claude Desktop.')} values={{ file: <code>%APPDATA%\Claude\claude_desktop_config.json</code> }} />
            </li>
            <li>
              <b>Claude Code</b>{': '}
              <Rich text={t('save it as {file} in your project, restart, and run {command} to check.')} values={{ file: <code>.mcp.json</code>, command: <code>/mcp</code> }} />
            </li>
          </ul>
        </div>
      </ConfigRow>
      <ConfigRow id="diaryAccess" htmlFor="cf-diary-access">
        <select id="cf-diary-access" className="field field--sm cf-select" value={diaryAccess} onChange={(e) => onDiaryAccess(e.target.value)}>
          <option value="none">{t('Nothing')}</option>
          <option value="summaries">{t('Daily summaries')}</option>
          <option value="full">{t('Summaries and entries')}</option>
        </select>
      </ConfigRow>
    </>
  );
}
