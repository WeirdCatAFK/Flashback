import React, { useState, useEffect } from "react";
import axios from "axios";
import "./Graph.css";
import ForceDirectedGraph from "./../components/d3/ForceDirectedGraph.jsx";

const GraphView = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Fetch data from the API endpoint
    axios
      .get("http://localhost:50500/nodes/graph")
      .then((response) => {
        // Assuming the response format matches the initial data structure
        setData(response.data);
      })
      .catch((error) => {
        console.error("Error fetching data:", error);
        setError("Failed to load graph data");
      });
  }, []);

  // Display loading or error message if needed
  if (error) return <div>{error}</div>;
  if (!data) return <div>Loading...</div>;

  return (
    <div className="graph-container">
      <h1 className="title">Brain Graph</h1>
      <ForceDirectedGraph data={data}></ForceDirectedGraph>
    </div>
  );
};

export default GraphView;
