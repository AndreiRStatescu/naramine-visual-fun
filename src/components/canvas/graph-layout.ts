import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node, XYPosition } from "@xyflow/react";

const NODE_WIDTH = 232;
const NODE_HEIGHT = 232;
const elk = new ELK();

type LayoutMode = "missing" | "all";

function intersects(position: XYPosition, occupied: XYPosition[]) {
  return occupied.some(
    (other) =>
      Math.abs(other.x - position.x) < NODE_WIDTH + 34 &&
      Math.abs(other.y - position.y) < NODE_HEIGHT + 34,
  );
}

function freePosition(
  position: XYPosition,
  occupied: XYPosition[],
): XYPosition {
  if (!intersects(position, occupied)) return position;
  for (let ring = 1; ring < 18; ring += 1) {
    const candidates = [
      { x: position.x, y: position.y + ring * (NODE_HEIGHT + 48) },
      { x: position.x, y: position.y - ring * (NODE_HEIGHT + 48) },
      { x: position.x + ring * (NODE_WIDTH + 96), y: position.y },
      { x: position.x - ring * (NODE_WIDTH + 96), y: position.y },
    ];
    const candidate = candidates.find((value) => !intersects(value, occupied));
    if (candidate) return candidate;
  }
  return position;
}

export async function layoutGraph<NodeType extends Node>(
  nodes: NodeType[],
  edges: Edge[],
  mode: LayoutMode,
): Promise<NodeType[]> {
  if (!nodes.length) return nodes;

  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.layered.spacing.nodeNodeBetweenLayers": "112",
      "elk.spacing.nodeNode": "58",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.padding": "[top=52,left=52,bottom=52,right=52]",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: node.measured?.width ?? node.width ?? NODE_WIDTH,
      height: node.measured?.height ?? node.height ?? NODE_HEIGHT,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  });

  const calculated = new Map(
    (graph.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  );

  if (mode === "all") {
    return nodes.map((node) => ({
      ...node,
      position: calculated.get(node.id) ?? node.position,
    }));
  }

  const anchored = nodes.filter(
    (node) => node.data.__hasLayoutPosition === true,
  );
  const firstAnchor = anchored.find((node) => calculated.has(node.id));
  const translation = firstAnchor
    ? {
        x: firstAnchor.position.x - (calculated.get(firstAnchor.id)?.x ?? 0),
        y: firstAnchor.position.y - (calculated.get(firstAnchor.id)?.y ?? 0),
      }
    : { x: 0, y: 0 };
  const occupied = anchored.map((node) => node.position);

  return nodes.map((node) => {
    if (node.data.__hasLayoutPosition === true) return node;
    const raw = calculated.get(node.id) ?? node.position;
    const position = freePosition(
      { x: raw.x + translation.x, y: raw.y + translation.y },
      occupied,
    );
    occupied.push(position);
    return { ...node, position };
  });
}
