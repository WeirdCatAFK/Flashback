/**
 * Documents — the file tree beside the document editor. The tree is docked (and
 * resizable, snapping to set widths) or hidden; hidden, it slides out when the
 * pointer rests left of the text. Whether it is shown is App's state, because the
 * Documents icon in the activity bar toggles it too. Tabs, preview tabs and the
 * jump-to-highlight hand-over live in useOpenTabs.js; the width in
 * useSidebarResize.js; the slide-out in useTreePeek.js.
 */

import { useRef } from 'react';
import FileExplorer from '../../components/document/explorer/FileExplorer';
import DocumentEditor from '../../components/document/DocumentEditor';
import { useT } from '../../translations/index';
import useSidebarResize from './useSidebarResize';
import useTreePeek from './useTreePeek';
import useOpenTabs from './useOpenTabs';
import './Documents.css';

/** The tab bar's first slot: shows or hides the file tree. */
function TreeToggle({ docked, onToggle }) {
  const { t } = useT();
  const label = docked ? t('Hide the file tree') : t('Show the file tree');
  return (
    <button type="button" className="tree-toggle" aria-pressed={docked} aria-label={label} title={label} onClick={onToggle}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" opacity="0.45" />
        <path d="M3 2.5h2.5v11H3a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 3 2.5Z" />
      </svg>
    </button>
  );
}

export default function DocumentsView({ isActive, treeHidden = false, onToggleTree, openPaths, toggleOpen, relocatePaths, selectedPath, onSelect, onStudy, openSource, onOpenSourceConsumed }) {
  const { t } = useT();
  const sidebar = useSidebarResize();
  const treeRef = useRef(null);
  const peek = useTreePeek({ hidden: treeHidden, treeRef });
  const tabs = useOpenTabs({ selectedPath, onSelect, relocatePaths, openSource, onOpenSourceConsumed });

  const choose = (path) => { tabs.select(path); peek.afterOpen(); };
  const pin = (path) => { tabs.pin(path); peek.afterOpen(); };

  return (
    <div
      className={`documents-view${treeHidden ? ' documents-view--hidden' : ''}`}
      style={{ '--tree-w': `${sidebar.width}px` }}
    >
      <aside
        ref={treeRef}
        className={`documents-tree${peek.peek ? ' is-peek' : ''}${sidebar.resizing ? ' is-resizing' : ''}`}
        aria-label={t('Files')}
        {...peek.treeProps}
      >
        <div className="documents-tree__inner">
          <FileExplorer
            workspaceName={t('Workspace')}
            onSelect={choose}
            onDoubleSelect={pin}
            selectedPath={selectedPath}
            openPaths={openPaths}
            toggleOpen={toggleOpen}
            relocatePaths={tabs.relocateTabs}
            onStudy={onStudy}
          />
        </div>
        {!treeHidden && (
          <div
            className="documents-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize the file tree')}
            title={t('Drag to resize. Double-click to reset.')}
            tabIndex={0}
            {...sidebar.handleProps}
          />
        )}
      </aside>

      <main className="documents-main" {...peek.bodyProps}>
        <span className={`documents-peek-hint${peek.hint ? ' is-on' : ''}`} aria-hidden="true" />
        <DocumentEditor
          isActive={isActive}
          treeToggle={<TreeToggle docked={!treeHidden} onToggle={onToggleTree} />}
          openTabs={tabs.openTabs}
          activeTab={selectedPath}
          previewTab={tabs.previewTab}
          onTabChange={onSelect}
          onTabClose={tabs.close}
          onTabDoubleClick={tabs.pinTab}
          pendingHighlight={tabs.pendingHighlight}
          onHighlightConsumed={tabs.consumeHighlight}
          onNavigate={tabs.select}
          relocation={tabs.relocation}
        />
      </main>
    </div>
  );
}
