import { useState, useEffect } from 'react';
import { getGraph } from '../api/documents';

function useGraph() {
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getGraph()
      .then(setGraph)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return { graph, loading, error };
}

export default function GraphView() {
  const { graph, loading, error } = useGraph();

  if (loading) return <p>Loading graph...</p>;
  if (error) return <p>Error: {error.message}</p>;
  if (!graph) return null;

  const { nodes = [], edges = [] } = graph;
  const labelById = Object.fromEntries(nodes.map(n => [n.id, n.label ?? String(n.id)]));

  return (
    <div>
      <h2>Knowledge Graph</h2>
      <p>{nodes.length} nodes · {edges.length} connections</p>

      <details open>
        <summary>Nodes ({nodes.length})</summary>
        <ul>
          {nodes.map(node => (
            <li key={node.id}>
              [{node.type}] {node.label ?? node.id}
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Connections ({edges.length})</summary>
        <ul>
          {edges.map((edge, i) => (
            <li key={i}>
              {labelById[edge.fromId]} →{edge.relation ? ` (${edge.relation})` : ''} {labelById[edge.toId]}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
