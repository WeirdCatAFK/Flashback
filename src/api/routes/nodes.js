import express from "express";
import db from "../config/DatabaseManager.js";

const nodes_router = express.Router();

// Get graph data
nodes_router.get("/graph", async (req, res) => {
  try {
    // Get all nodes with their types, names, and IDs in a single query
    const nodes = await db.all(`
      SELECT 
        n.id AS id, 
        n.presence AS presence, 
        CASE 
          WHEN n.type_id = 1 THEN f.name
          WHEN n.type_id = 2 THEN d.name
          WHEN n.type_id = 3 THEN fc.name
          WHEN n.type_id = 4 THEN t.name
          ELSE 'Unknown'
        END AS name,
        n.type_id AS type
      FROM 
        Nodes n
      LEFT JOIN Folders f ON n.id = f.node_id AND n.type_id = 1
      LEFT JOIN Documents d ON n.id = d.node_id AND n.type_id = 2
      LEFT JOIN Flashcards fc ON n.id = fc.node_id AND n.type_id = 3
      LEFT JOIN Tags t ON n.id = t.id AND n.type_id = 4
    `);

    // Get all connections in a single query
    const links = await db.all(`
      SELECT 
        origin_id AS source, 
        destiny_id AS target 
      FROM 
        Node_connections
    `);

    // Format data specifically for the JSON response
    const graphData = {
      nodes: nodes,
      links: links,
    };

    res.status(200).json({ code: 200, message: graphData });
  } catch (error) {
    console.error("Error fetching graph data:", error);
    res.status(500).json({ code: 500, error: "Failed to fetch graph data" });
  }
});

export default nodes_router;
