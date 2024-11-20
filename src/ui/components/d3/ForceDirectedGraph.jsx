import React, { useRef, useEffect } from "react";
import * as d3 from "d3";

export default function ForceDirectedGraph({ data }) {
  const svgRef = useRef(null);

  useEffect(() => {
    const width = 1800;
    const height = 900;

    // Clear the SVG for re-renders
    d3.select(svgRef.current).selectAll("*").remove();

    // Create the SVG container
    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .style("max-width", "100%")
      .style("height", "auto")
      .call(
        d3.zoom().on("zoom", (event) => {
          g.attr("transform", event.transform);
        })
      );

    // Add a container group to support zooming/panning
    const g = svg.append("g");

    // Color scale based on node type
    const color = d3.scaleOrdinal(d3.schemeCategory10);

    // Extract nodes and links from the provided data
    const nodes = data.message.nodes.map((d) => ({ ...d }));
    const links = data.message.links.map((d) => ({ ...d }));

    // Create the force simulation
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(150)
      )
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2));

    // Add links to the SVG
    const link = g
      .append("g")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", (d) => Math.sqrt(d.value) || 2);

    // Add the translucent growing circle before the nodes
    const presenceCircle = g
      .append("g")
      .selectAll("circle.presence")
      .data(nodes)
      .join("circle")
      .attr("class", "presence")
      .attr("fill", "rgba(0, 123, 255, 0.3)") // Light blue with transparency
      .attr("r", (d) => d.presence * 5 || 0)  // Adjust the multiplier for size
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y);

    // Add nodes to the SVG
    const node = g
      .append("g")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5)
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("r", 8)
      .attr("fill", (d) => color(d.type))
      .call(drag(simulation))
      .on("mouseover", handleMouseOver)
      .on("mouseout", handleMouseOut)
      .on("click", handleClick);

    // Add titles directly next to nodes
    const title = g
      .append("g")
      .selectAll("text")
      .data(nodes)
      .join("text")
      .attr("x", (d) => d.x + 10)  // Position the title to the right of the node
      .attr("y", (d) => d.y)
      .attr("font-size", "14px")  // Increase the font size
      .attr("fill", "#333")
      .text((d) => d.name || d.id);  // Display the name or ID of the node

    // Update positions on each tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
      title.attr("x", (d) => d.x + 10).attr("y", (d) => d.y);  // Update title position
      presenceCircle.attr("cx", (d) => d.x).attr("cy", (d) => d.y); // Update presence circle position
    });

    // Drag behavior functions
    function drag(simulation) {
      return d3
        .drag()
        .on("start", (event) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on("drag", (event) => {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        })
        .on("end", (event) => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        });
    }

    // Mouseover event to highlight node
    function handleMouseOver(event, d) {
      d3.select(this).attr("stroke-width", 3);
      tooltip
        .style("visibility", "visible")
        .text(`${d.name || d.id}`)
        .style("top", `${event.pageY - 10}px`)
        .style("left", `${event.pageX + 10}px`);
    }

    // Mouseout event to remove highlight
    function handleMouseOut() {
      d3.select(this).attr("stroke-width", 1.5);
      tooltip.style("visibility", "hidden");
    }

    // Click event to handle additional interactions
    function handleClick(event, d) {
      alert(`Clicked on node: ${d.name || d.id}`);
    }

    // Tooltip for nodes (optional)
    const tooltip = d3
      .select("body")
      .append("div")
      .attr("class", "tooltip")
      .style("position", "absolute")
      .style("visibility", "hidden")
      .style("background", "#f9f9f9")
      .style("padding", "8px")
      .style("border-radius", "4px")
      .style("box-shadow", "0px 0px 10px rgba(0, 0, 0, 0.1)");

    // Cleanup on component unmount
    return () => {
      simulation.stop();
      tooltip.remove();
    };
  }, [data]);

  return <svg ref={svgRef}></svg>;
}
