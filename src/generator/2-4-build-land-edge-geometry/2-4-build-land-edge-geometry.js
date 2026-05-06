/*
 * WHAT: Normalize post-parish lot geometry and smooth inter-parish borders before field dispatch.
 * HOW: Preserve sea/coast edges, curve eligible parish-border chains, and resample the remaining land edges.
 * WHY: Later steps should consume one canonical sampled geometry with parish borders already baked in.
 */

import { DEFAULT_SEGMENT_LENGTH, clonePoint, convertLotGeometryToLandEdgeGeometry, midpointBetween, pointDistance } from "../map-model.js";
import { buildRouteGraph } from "../route-graph.js";

export function runBuildLandEdgeGeometryStep(map) {
  const geometryMap = convertLotGeometryToLandEdgeGeometry(map, DEFAULT_SEGMENT_LENGTH * 2);
  const routeGraph = appendStoredStreetRoutes(buildRouteGraph(geometryMap), map.roadNetwork?.streetRoutes || []);
  const nextMap = {
    ...geometryMap,
    routeGraph,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.4 / Land edges + parish borders",
        map: nextMap,
      },
    ],
  };
}

function appendStoredStreetRoutes(routeGraph, streetRoutes) {
  if (!Array.isArray(streetRoutes) || !streetRoutes.length) {
    return routeGraph;
  }
  const nodes = routeGraph.nodes.map((node) => ({ ...node, routeIds: [...(node.routeIds || [])] }));
  const routes = routeGraph.routes.map((route) => ({ ...route, features: { ...(route.features || {}) } }));
  const nodeByKey = new Map(nodes.map((node) => [pointKey(node), node.id]));

  streetRoutes.forEach((streetRoute) => {
    if (!streetRoute.from || !streetRoute.to) {
      return;
    }
    const fromNodeId = getOrCreateStreetNode(nodes, nodeByKey, streetRoute.from, streetRoute.fromNode);
    const toNodeId = getOrCreateStreetNode(nodes, nodeByKey, streetRoute.to, streetRoute.toNode);
    if (fromNodeId === toNodeId) {
      return;
    }
    const route = {
      id: `route:${routes.length}`,
      fromNodeId,
      toNodeId,
      type: "street",
      length: pointDistance(streetRoute.from, streetRoute.to),
      midpoint: clonePoint(streetRoute.midpoint || midpointBetween(streetRoute.from, streetRoute.to)),
      sourceSegmentId: null,
      leftLotId: streetRoute.leftLotId ?? null,
      rightLotId: streetRoute.rightLotId ?? null,
      leftSublotId: null,
      rightSublotId: null,
      features: {
        ...(streetRoute.features || {}),
        street: true,
        routeType: "street",
      },
    };
    routes.push(route);
    nodes[fromNodeId].routeIds.push(route.id);
    nodes[toNodeId].routeIds.push(route.id);
  });

  return { nodes, routes };
}

function getOrCreateStreetNode(nodes, nodeByKey, point, sourceNode = null) {
  const key = pointKey(point);
  const existing = nodeByKey.get(key);
  if (existing !== undefined) {
    applyStreetNodeMetadata(nodes[existing], sourceNode);
    return existing;
  }
  const id = nodes.length;
  nodes.push({
    id,
    x: point.x,
    y: point.y,
    routeIds: [],
    type: sourceNode?.type || "road",
    lotId: sourceNode?.lotId ?? null,
    parishId: sourceNode?.parishId ?? null,
    sourceVertexIds: [...(sourceNode?.sourceVertexIds || [])],
    features: {
      ...(sourceNode?.features || {}),
      street: true,
    },
  });
  nodeByKey.set(key, id);
  return id;
}

function applyStreetNodeMetadata(node, sourceNode) {
  if (!sourceNode) {
    node.features = {
      ...(node.features || {}),
      street: true,
    };
    return;
  }
  if (sourceNode.type === "lot_center") {
    node.type = "lot_center";
    node.lotId = sourceNode.lotId ?? node.lotId ?? null;
    node.parishId = sourceNode.parishId ?? node.parishId ?? null;
  }
  (sourceNode.sourceVertexIds || []).forEach((vertexId) => {
    if (!node.sourceVertexIds.includes(vertexId)) {
      node.sourceVertexIds.push(vertexId);
    }
  });
  node.features = {
    ...(node.features || {}),
    ...(sourceNode.features || {}),
    street: true,
  };
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}
