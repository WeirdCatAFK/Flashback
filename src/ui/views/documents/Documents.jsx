/**
 * Documents — the file explorer beside the document editor, with a resizable
 * sidebar between them. Tabs, preview tabs and the jump-to-highlight hand-over
 * live in useOpenTabs.js; the sidebar width in useSidebarResize.js.
 */

import FileExplorer from '../../components/document/explorer/FileExplorer';
import DocumentEditor from '../../components/document/DocumentEditor';
import { useT } from '../../translations/index';
import useSidebarResize from './useSidebarResize';
import useOpenTabs from './useOpenTabs';
import './Documents.css';

export default function DocumentsView({ isActive, openPaths, toggleOpen, relocatePaths, selectedPath, onSelect, onStudy, openSource, onOpenSourceConsumed }) {
  const { t } = useT();
  const sidebar = useSidebarResize();
  const tabs = useOpenTabs({ selectedPath, onSelect, relocatePaths, openSource, onOpenSourceConsumed });

  return (
    <div className="documents-view">
      <aside className="documents-sidebar" style={{ width: sidebar.width }}>
        <FileExplorer
          workspaceName={t('Workspace')}
          onSelect={tabs.select}
          onDoubleSelect={tabs.pin}
          selectedPath={selectedPath}
          openPaths={openPaths}
          toggleOpen={toggleOpen}
          relocatePaths={tabs.relocateTabs}
          onStudy={onStudy}
        />
      </aside>

      <div
        className="documents-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Resize sidebar')}
        tabIndex={0}
        {...sidebar.handleProps}
      />

      <main className="documents-main">
        <DocumentEditor
          isActive={isActive}
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
