/*
 * WHAT: Re-append stored road-network connector routes after geometry rebuilds.
 * HOW: Snap route endpoints to rebuilt lot boundary nodes or lot centroids before inserting routes.
 * WHY: Temporary connector routes promoted in step 2.3 have no source segment, so rebuild passes must restore them.
 */

import { clonePoint, midpointBetween, pointDistance } from "./map-model.js";

export function appendStoredRoadNetworkRoutes(routeGraph, map, storedRoutes) {
  if (!Array.isArray(storedRoutes) || !storedRoutes.length) {
    return routeGraph;
  }
  const lotsById = new Map((map.lots || []).map((lot) => [lot.id, lot]));
  const nodes = routeGraph.nodes.map((node) => ({ ...node, routeIds: [...(node.routeIds || [])] }));
  const routes = routeGraph.routes.map((route) => ({ ...route, features: { ...(route.features || {}) } }));
  const nodeByKey = new Map(nodes.map((node) => [pointKey(node), node.id]));

  storedRoutes.forEach((storedRoute) => {
    if (!storedRoute.from || !storedRoute.to) {
      return;
    }
    const routeType = storedRoute.features?.routeType === "road" || storedRoute.type === "road" ? "road" : "street";
    const fromPoint = resolveStoredRoutePoint(storedRoute.from, storedRoute.fromNode, storedRoute, routeGraph, lotsById);
    const toPoint = resolveStoredRoutePoint(storedRoute.to, storedRoute.toNode, storedRoute, routeGraph, lotsById);
    const fromNodeId = getOrCreateStoredRouteNode(nodes, nodeByKey, fromPoint, storedRoute.fromNode, routeType);
    const toNodeId = getOrCreateStoredRouteNode(nodes, nodeByKey, toPoint, storedRoute.toNode, routeType);
    if (fromNodeId === toNodeId) {
      return;
    }
    const route = {
      id: `route:${routes.length}`,
      fromNodeId,
      toNodeId,
      type: routeType,
      length: pointDistance(fromPoint, toPoint),
      midpoint: midpointBetween(fromPoint, toPoint),
      sourceSegmentId: null,
      leftLotId: storedRoute.leftLotId ?? null,
      rightLotId: storedRoute.rightLotId ?? null,
      leftSublotId: null,
      rightSublotId: null,
      features: {
        ...(storedRoute.features || {}),
        road: routeType === "road",
        street: routeType === "street",
        alley: false,
        routeType,
      },
    };
    routes.push(route);
    nodes[fromNodeId].routeIds.push(route.id);
    nodes[toNodeId].routeIds.push(route.id);
  });

  return { nodes, routes };
}

function resolveStoredRoutePoint(point, sourceNode, storedRoute, routeGraph, lotsById) {
  const lotId = sourceNode?.lotId ?? storedRoute.leftLotId ?? storedRoute.rightLotId ?? null;
  const lot = lotId === null || lotId === undefined ? null : lotsById.get(lotId);
  if (sourceNode?.type === "lot_center" || sourceNode?.features?.lotCenter) {
    return clonePoint(lot?.centroid || point);
  }

  const candidates = findRouteNodesForLot(routeGraph, lotId);
  if (!candidates.length) {
    return clonePoint(point);
  }

  return clonePoint(candidates
    .sort((first, second) => pointDistance(first, point) - pointDistance(second, point) || first.id - second.id)[0]);
}

function findRouteNodesForLot(routeGraph, lotId) {
  if (lotId === null || lotId === undefined) {
    return [];
  }
  const nodeIds = new Set();
  (routeGraph.routes || []).forEach((route) => {
    if (route.leftLotId !== lotId && route.rightLotId !== lotId) {
      return;
    }
    nodeIds.add(route.fromNodeId);
    nodeIds.add(route.toNodeId);
  });
  return Array.from(nodeIds)
    .map((nodeId) => routeGraph.nodes.find((node) => node.id === nodeId))
    .filter(Boolean);
}

function getOrCreateStoredRouteNode(nodes, nodeByKey, point, sourceNode = null, routeType = "street") {
  const key = pointKey(point);
  const existing = nodeByKey.get(key);
  if (existing !== undefined) {
    applyStoredRouteNodeMetadata(nodes[existing], sourceNode, routeType);
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
      road: routeType === "road",
      street: routeType === "street",
    },
  });
  nodeByKey.set(key, id);
  return id;
}

function applyStoredRouteNodeMetadata(node, sourceNode, routeType = "street") {
  if (!sourceNode) {
    node.features = {
      ...(node.features || {}),
      road: routeType === "road" || Boolean(node.features?.road),
      street: routeType === "street" || Boolean(node.features?.street),
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
    road: routeType === "road" || Boolean(node.features?.road),
    street: routeType === "street" || Boolean(node.features?.street),
  };
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}
