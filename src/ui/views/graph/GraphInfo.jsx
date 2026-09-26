/**
 * GraphInfo — the panel for a selected node: its type and name, and its
 * neighbours grouped by type with the relation that reaches them. Documents and
 * flashcards are chips that navigate; the rest are labels.
 */

import { useT } from '../../translations/index';
import { nodeDisplayName } from './graphData.js';

const LIMIT = 5;

function NeighborChip({ node, onNavigate }) {
  const displayName = nodeDisplayName(node);
  const title = node.type === 'Flashcard' && node.flashcardFront ? node.flashcardFront : node.name;
  const target = node.type === 'Flashcard' && node.flashcardDocPath
    ? { type: 'flashcard', payload: { documentPath: node.flashcardDocPath } }
    : node.type === 'Document' && node.documentPath
      ? { type: 'document', payload: { path: node.documentPath } }
      : null;
  if (onNavigate && target) {
    return (
      <button type="button" className="graph-info-neighbor graph-info-neighbor--link" title={title} onClick={() => onNavigate(target)}>
        {displayName}
      </button>
    );
  }
  return <span className="graph-info-neighbor" title={title}>{displayName}</span>;
}

export default function GraphInfo({ selected, groups, colors, typeLabel, relationLabel, onNavigate, onClose }) {
  const { t } = useT();
  return (
    <div className="graph-info">
      <div className="graph-info-type">
        <span className="graph-info-group-dot" style={{ background: colors.nodes[selected.type] }} />
        {typeLabel(selected.type)}
      </div>
      <div className="graph-info-name">{selected.name}</div>
      <button type="button" className="btn-close graph-info-close" onClick={onClose} aria-label={t('Close')}>×</button>

      {groups.length > 0 && (
        <div className="graph-info-neighbors">
          {groups.map(({ type, nodes }) => {
            const shown = nodes.slice(0, LIMIT);
            const overflow = nodes.length - LIMIT;
            return (
              <div key={type} className="graph-info-group">
                <div className="graph-info-group-header">
                  <span className="graph-info-group-dot" style={{ background: colors.nodes[type] }} />
                  <span className="graph-info-group-label">{relationLabel(selected.type, type, nodes[0].relation, nodes[0].direction)}</span>
                  <span className="graph-info-group-count">{nodes.length}</span>
                </div>
                <div className="graph-info-group-items">
                  {shown.map((n) => <NeighborChip key={n.id} node={n} onNavigate={onNavigate} />)}
                  {overflow > 0 && <span className="graph-info-overflow">{t('+{n} more', { n: overflow })}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
