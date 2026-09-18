/**
 * McpIntegration — the MCP server snippet for an AI assistant, with copy and
 * the two places it goes. Read from Electron main, which mints the token.
 */

import { useState, useEffect } from 'react';
import { getMcpConfig, isDesktop } from '../../api/desktop';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';

export default function McpIntegration() {
  const { t } = useT();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    getMcpConfig()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }, []);

  const handleCopy = () => {
    if (!state.data) return;
    navigator.clipboard.writeText(state.data.json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (state.loading) return <p className="config-hint">{t('Loading…')}</p>;
  if (state.error) return <p className="theme-editor-error">{state.error.message}</p>;

  return (
    <div className="mcp-integration">
      <p className="config-hint">
        {t('Connect an AI assistant to this vault — it can search your notes, draft flashcards from a document, and add them to a deck, right from a conversation.')}
      </p>

      <div className="theme-text-panel">
        <div className="theme-text-toolbar">
          <span className="theme-text-label">{t('MCP config')}</span>
          <button type="button" className="btn btn--sm" onClick={handleCopy}>
            {copied ? t('Copied!') : t('Copy')}
          </button>
        </div>
        <textarea
          className="field theme-textarea"
          aria-label={t('MCP server configuration JSON')}
          value={state.data?.json ?? ''}
          readOnly
          spellCheck={false}
          rows={8}
        />
      </div>

      <ul className="mcp-instructions">
        <li>
          <strong>Claude Desktop</strong>{' — '}
          <Rich
            text={t('paste this into {file}, then restart Claude Desktop.')}
            values={{ file: <code>%APPDATA%\Claude\claude_desktop_config.json</code> }}
          />
        </li>
        <li>
          <strong>Claude Code</strong>{' — '}
          <Rich
            text={t('save this as {file} in your project, then restart and run {command} to check the connection.')}
            values={{ file: <code>.mcp.json</code>, command: <code>/mcp</code> }}
          />
        </li>
      </ul>

      <p className="config-hint">
        {t('Flashback needs to be running for this to work.')}
      </p>
    </div>
  );
}
