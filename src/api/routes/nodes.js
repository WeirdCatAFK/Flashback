import express from "express";
import db from "../config/dbmanager.js";

const nodes_router = express.Router();

// Get graph data formatted for D3.js force-directed graph
nodes_router.get("/graph", async (req, res) => {
  try {
    // Get all nodes with their types and names in a single query
    const nodes = await db.all(`
      SELECT 
        n.id,
        n.type_id,
        n.presence,
        nt.name as type,
        COALESCE(f.name, d.name, fc.name, t.name) as name,
        CASE 
          WHEN f.id IS NOT NULL THEN 'folder'
          WHEN d.id IS NOT NULL THEN 'document'
          WHEN fc.id IS NOT NULL THEN 'flashcard'
          WHEN t.id IS NOT NULL THEN 'tag'
        END as category,
        -- Get count of connections for each node
        (
          SELECT COUNT(*) 
          FROM Node_connections nc 
          WHERE nc.origin_id = n.id OR nc.destiny_id = n.id
        ) as connection_count
      FROM Nodes n
      JOIN Node_types nt ON n.type_id = nt.id
      LEFT JOIN Folders f ON n.id = f.node_id
      LEFT JOIN Documents d ON n.id = d.node_id
      LEFT JOIN Flashcards fc ON n.id = fc.node_id
      LEFT JOIN Tags t ON n.id = t.id
      WHERE n.presence > 0
    `);

    // Get all connections in a single query
    const links = await db.all(`
      SELECT 
        nc.id,
        nc.origin_id as source,
        nc.destiny_id as target,
        ct.name as type,
        GROUP_CONCAT(t.name) as inherited_tags,
        -- Calculate connection strength based on shared tags
        COUNT(DISTINCT it.tag_id) as strength
      FROM Node_connections nc
      JOIN Connection_types ct ON nc.connection_type_id = ct.id
      LEFT JOIN Inherited_tags it ON nc.id = it.connection_id
      LEFT JOIN Tags t ON it.tag_id = t.id
      WHERE (
        SELECT presence 
        FROM Nodes 
        WHERE id = nc.origin_id
      ) > 0
      AND (
        SELECT presence 
        FROM Nodes 
        WHERE id = nc.destiny_id
      ) > 0
      GROUP BY nc.id
    `);

    // Calculate graph metrics for better visualization
    const maxPresence = Math.max(...nodes.map((n) => n.presence));
    const maxConnections = Math.max(...nodes.map((n) => n.connection_count));

    // Format data specifically for D3.js
    const graphData = {
      nodes: nodes.map((node) => ({
        id: node.id,
        name: node.name,
        category: node.category,
        type: node.type,
        // Scale node size between 5 and 30 based on presence
        radius: 5 + (node.presence / maxPresence) * 25,
        // Calculate node's importance for force layout
        weight: node.connection_count / maxConnections,
        presence: node.presence,
        connectionCount: node.connection_count,
        // Add properties for D3 force simulation
        x: undefined,
        y: undefined,
        vx: undefined,
        vy: undefined,
        fx: null,
        fy: null,
      })),
      links: links.map((link) => ({
        id: link.id,
        source: link.source,
        target: link.target,
        type: link.type,
        // Scale link strength based on number of shared tags
        value: link.strength,
        inheritedTags: link.inherited_tags
          ? link.inherited_tags.split(",")
          : [],
      })),
      // Add categories for creating a color scale in D3
      categories: [...new Set(nodes.map((n) => n.category))],
      // Add metadata for visualization configuration
      metadata: {
        maxPresence,
        maxConnections,
        nodeCount: nodes.length,
        linkCount: links.length,
      },
    };

    res.json(graphData);
  } catch (error) {
    console.error("Error fetching graph data:", error);
    res.status(500).json({ error: "Failed to fetch graph data" });
  }
});

// Get node details with connected nodes for hover/click interactions
nodes_router.get("/:id/details", async (req, res) => {
  try {
    const [nodeDetails, connections] = await Promise.all([
      // Get detailed node information
      db.get(
        `
        SELECT 
          n.id,
          n.presence,
          nt.name as type,
          COALESCE(f.name, d.name, fc.name, t.name) as name,
          CASE 
            WHEN f.id IS NOT NULL THEN 'folder'
            WHEN d.id IS NOT NULL THEN 'document'
            WHEN fc.id IS NOT NULL THEN 'flashcard'
            WHEN t.id IS NOT NULL THEN 'tag'
          END as category,
          f.filepath as folder_path,
          d.filepath as document_path,
          fc.front as flashcard_front,
          fc.back as flashcard_back
        FROM Nodes n
        JOIN Node_types nt ON n.type_id = nt.id
        LEFT JOIN Folders f ON n.id = f.node_id
        LEFT JOIN Documents d ON n.id = d.node_id
        LEFT JOIN Flashcards fc ON n.id = fc.node_id
        LEFT JOIN Tags t ON n.id = t.id
        WHERE n.id = ?
      `,
        [req.params.id]
      ),

      // Get connected nodes information
      db.all(
        `
        SELECT 
          nc.id as connection_id,
          n2.id as connected_node_id,
          COALESCE(f.name, d.name, fc.name, t.name) as connected_node_name,
          nt.name as connected_node_type,
          ct.name as connection_type,
          GROUP_CONCAT(t2.name) as shared_tags,
          CASE 
            WHEN nc.origin_id = ? THEN 'outgoing'
            ELSE 'incoming'
          END as direction
        FROM Node_connections nc
        JOIN Nodes n2 ON (nc.origin_id = n2.id OR nc.destiny_id = n2.id)
        JOIN Node_types nt ON n2.type_id = nt.id
        JOIN Connection_types ct ON nc.connection_type_id = ct.id
        LEFT JOIN Folders f ON n2.id = f.node_id
        LEFT JOIN Documents d ON n2.id = d.node_id
        LEFT JOIN Flashcards fc ON n2.id = fc.node_id
        LEFT JOIN Tags t ON n2.id = t.id
        LEFT JOIN Inherited_tags it ON nc.id = it.connection_id
        LEFT JOIN Tags t2 ON it.tag_id = t2.id
        WHERE (nc.origin_id = ? OR nc.destiny_id = ?)
        AND n2.id != ?
        GROUP BY nc.id
      `,
        [req.params.id, req.params.id, req.params.id, req.params.id]
      ),
    ]);

    if (!nodeDetails) {
      return res.status(404).json({ error: "Node not found" });
    }

    // Format response for D3 tooltip/details panel
    res.json({
      node: nodeDetails,
      connections: connections,
      metrics: {
        totalConnections: connections.length,
        incomingConnections: connections.filter(
          (c) => c.direction === "incoming"
        ).length,
        outgoingConnections: connections.filter(
          (c) => c.direction === "outgoing"
        ).length,
      },
    });
  } catch (error) {
    console.error("Error fetching node details:", error);
    res.status(500).json({ error: "Failed to fetch node details" });
  }
});

// Update node position (for saving graph layout)
nodes_router.patch("/:id/position", async (req, res) => {
  const { x, y } = req.body;

  try {
    // Store positions in a new table or as metadata
    await db.run(
      `
      INSERT OR REPLACE INTO Node_layout (node_id, x, y)
      VALUES (?, ?, ?)
    `,
      [req.params.id, x, y]
    );

    res.json({ message: "Position updated successfully" });
  } catch (error) {
    console.error("Error updating node position:", error);
    res.status(500).json({ error: "Failed to update node position" });
  }
});

// The rest of the nodes_router implementation remains the same...

export default nodes_router;
