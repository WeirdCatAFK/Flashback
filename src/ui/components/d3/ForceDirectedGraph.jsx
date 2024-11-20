import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { Card, CardContent } from "@/components/ui/card";

export default function ForceDirectedGraph() {
  const svgRef = useRef(null);
  const [graphData, setGraphData] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [simulation, setSimulation] = useState(null);

  // Fetch graph data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch("http://localhost:50500/nodes/graph");
        const data = await response.json();
        setGraphData(data);
      } catch (error) {
        console.error("Error fetching graph data:", error);
      }
    };

    fetchData();
  }, []);

  // Initialize and update the force simulation
  useEffect(() => {
    if (!graphData || !svgRef.current) return;

    const width = 800;
    const height = 600;

    // Clear existing SVG content
    d3.select(svgRef.current).selectAll("*").remove();

    // Create SVG
    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height);

    // Add zoom behavior
    const zoom = d3
      .zoom()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        container.attr("transform", event.transform);
      });

    svg.call(zoom);

    // Create container for zoom transforms
    const container = svg.append("g");

    // Create color scale based on node categories
    const colorScale = d3
      .scaleOrdinal()
      .domain(graphData.categories)
      .range(d3.schemeCategory10);

    // Initialize force simulation
    const sim = d3
      .forceSimulation(graphData.nodes)
      .force(
        "link",
        d3
          .forceLink(graphData.links)
          .id((d) => d.id)
          .distance(100)
          .strength((l) => 0.1 + l.value * 0.1)
      )
      .force(
        "charge",
        d3.forceManyBody().strength((d) => -100 * d.weight)
      )
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collision",
        d3.forceCollide().radius((d) => d.radius + 5)
      );

    // Create links
    const links = container
      .selectAll(".link")
      .data(graphData.links)
      .join("line")
      .attr("class", "link")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", (d) => Math.sqrt(d.value));

    // Create nodes
    const nodes = container
      .selectAll(".node")
      .data(graphData.nodes)
      .join("g")
      .attr("class", "node")
      .call(
        d3
          .drag()
          .on("start", dragStarted)
          .on("drag", dragged)
          .on("end", dragEnded)
      );

    // Add circles to nodes
    nodes
      .append("circle")
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => colorScale(d.category))
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);

    // Add labels to nodes
    nodes
      .append("text")
      .text((d) => d.name)
      .attr("dx", (d) => d.radius + 5)
      .attr("dy", ".35em")
      .attr("font-size", "12px")
      .attr("fill", "#333");

    // Handle node click for details
    nodes.on("click", async (event, d) => {
      event.stopPropagation();
      try {
        const response = await fetch(
          `http://localhost:50500/nodes/${d.id}/details`
        );
        const details = await response.json();
        setSelectedNode(details);
      } catch (error) {
        console.error("Error fetching node details:", error);
      }
    });

    // Update positions on simulation tick
    sim.on("tick", () => {
      links
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      nodes.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // Drag functions
    function dragStarted(event) {
      if (!event.active) sim.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragEnded(event) {
      if (!event.active) sim.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;

      // Save node position
      fetch(`http://localhost:50500/nodes/${event.subject.id}/position`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          x: event.subject.x,
          y: event.subject.y,
        }),
      }).catch(console.error);
    }

    setSimulation(sim);

    return () => {
      sim.stop();
    };
  }, [graphData]);

  return (
    <div className="flex gap-4">
      <div className="border rounded-lg p-4 bg-white">
        <svg ref={svgRef} className="w-full h-full" />
      </div>

      {selectedNode && (
        <Card className="w-80">
          <CardContent className="p-4">
            <h3 className="text-lg font-semibold mb-2">
              {selectedNode.node.name}
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              Type: {selectedNode.node.type}
            </p>

            <div className="space-y-2">
              <h4 className="font-medium">
                Connections ({selectedNode.metrics.totalConnections})
              </h4>
              <div className="text-sm">
                <p>Incoming: {selectedNode.metrics.incomingConnections}</p>
                <p>Outgoing: {selectedNode.metrics.outgoingConnections}</p>
              </div>

              <div className="mt-4">
                <h4 className="font-medium mb-2">Connected Nodes</h4>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {selectedNode.connections.map((conn) => (
                    <div
                      key={conn.connection_id}
                      className="text-sm p-2 bg-gray-50 rounded"
                    >
                      <p className="font-medium">{conn.connected_node_name}</p>
                      <p className="text-gray-600">
                        {conn.connection_type} ({conn.direction})
                      </p>
                      {conn.shared_tags && (
                        <p className="text-gray-500 text-xs mt-1">
                          Tags: {conn.shared_tags}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
