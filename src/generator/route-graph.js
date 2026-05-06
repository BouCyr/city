/*
 * WHAT: Build the node/route graph used by step 2+ pathfinding.
 * HOW: Deduplicate route endpoints into nodes, classify routes from segment/sublot topology,
 *      and derive node types from connected route types.
 * WHY: Later urban steps need a coherent graph contract instead of walking raw segment arrays.
 */

import { clonePoint, midpointBetween, pointDistance } from "./map-model.js";

const POINT_KEY_DIGITS = 4;
const EPSILON = 0.0001;

export function buildRouteGraph(map) {
  const nodes = [];
  const nodeByKey = new Map();
  const routes = [];
  const lotById = new Map((map.lots || []).map((lot) => [lot.id, lot]));
  const vertexIdsByPointKey = buildVertexIdsByPointKey(map.vertices || []);
  const vertexFeaturesByPointKey = buildVertexFeaturesByPointKey(map.vertices || []);

  (map.segments || []).forEach((segment) => {
    if (!segment?.from || !segment?.to || pointDistance(segment.from, segment.to) <= EPSILON) {
      return;
    }

    const fromNodeId = getOrCreateNode(nodes, nodeByKey, segment.from, vertexIdsByPointKey, vertexFeaturesByPointKey);
    const toNodeId = getOrCreateNode(nodes, nodeByKey, segment.to, vertexIdsByPointKey, vertexFeaturesByPointKey);
    if (fromNodeId === toNodeId) {
      return;
    }

    routes.push({
      id: `route:${routes.length}`,
      fromNodeId,
      toNodeId,
      type: classifySegmentRoute(segment, lotById),
      length: pointDistance(segment.from, segment.to),
      midpoint: clonePoint(segment.midpoint || midpointBetween(segment.from, segment.to)),
      sourceSegmentId: segment.id,
      leftLotId: segment.leftLotId ?? null,
      rightLotId: segment.rightLotId ?? null,
      leftSublotId: null,
      rightSublotId: null,
      features: {
        ...(segment.features || {}),
      },
    });
  });

  rebuildNodeRouteIds(nodes, routes);
  return {
    nodes: nodes.map((node) => ({
      ...node,
      type: classifyNodeType(node, routes),
    })),
    routes,
  };
}

export function addAlleyRoutesToRouteGraph(map, tessellation) {
  const graph = cloneRouteGraph(map.routeGraph || buildRouteGraph(map));
  const nodes = graph.nodes.map((node) => ({
    ...node,
    routeIds: [],
    sourceVertexIds: [...(node.sourceVertexIds || [])],
  }));
  const routes = graph.routes.map((route) => cloneRoute(route));
  const nodeByKey = new Map(nodes.map((node) => [pointKey(node), node.id]));
  const vertices = new Map((tessellation?.vertices || []).map((vertex) => [vertex.id, vertex]));
  const edgeOwners = new Map();

  (tessellation?.sublots || []).forEach((sublot) => {
    const vertexIds = sublot.vertexIds || [];
    for (let index = 0; index < vertexIds.length; index += 1) {
      const from = vertices.get(vertexIds[index]);
      const to = vertices.get(vertexIds[(index + 1) % vertexIds.length]);
      if (!from || !to || pointDistance(from, to) <= EPSILON) {
        continue;
      }

      const key = edgeKey(from, to);
      const owners = edgeOwners.get(key) || [];
      owners.push({
        sublotId: sublot.id,
        lotId: sublot.lotId,
        from,
        to,
      });
      edgeOwners.set(key, owners);
    }
  });

  edgeOwners.forEach((owners) => {
    if (owners.length < 2) {
      return;
    }

    const first = owners[0];
    const second = owners[1];
    const fromNodeId = getOrCreateNode(nodes, nodeByKey, first.from);
    const toNodeId = getOrCreateNode(nodes, nodeByKey, first.to);
    if (fromNodeId === toNodeId) {
      return;
    }

    routes.push({
      id: `route:${routes.length}`,
      fromNodeId,
      toNodeId,
      type: "alley",
      length: pointDistance(first.from, first.to),
      midpoint: midpointBetween(first.from, first.to),
      sourceSegmentId: null,
      leftLotId: first.lotId ?? null,
      rightLotId: second.lotId ?? null,
      leftSublotId: first.sublotId,
      rightSublotId: second.sublotId,
      features: {
        alley: true,
      },
    });
  });

  rebuildNodeRouteIds(nodes, routes);
  return {
    nodes: nodes.map((node) => ({
      ...node,
      type: classifyNodeType(node, routes),
    })),
    routes,
  };
}

export function addLotCenterAlleyRoutesToRouteGraph(map, lots = map.lots || [], routeFeatureOverrides = {}) {
  const graph = cloneRouteGraph(map.routeGraph || buildRouteGraph(map));
  const eligibleNodeIds = findLotCenterAlleyTargetNodeIds(graph);
  const nodes = graph.nodes.map((node) => ({
    ...node,
    routeIds: [],
    sourceVertexIds: [...(node.sourceVertexIds || [])],
  }));
  const routes = graph.routes.map((route) => cloneRoute(route));
  const nodeByKey = new Map(nodes.map((node) => [pointKey(node), node.id]));

  lots.forEach((lot) => {
    if (!lot.features?.land || lot.features?.sea || !lot.centroid || !Array.isArray(lot.polygon)) {
      return;
    }

    const centerNodeId = getOrCreateNode(nodes, nodeByKey, lot.centroid);
    nodes[centerNodeId].type = "lot_center";
    nodes[centerNodeId].lotId = lot.id;
    nodes[centerNodeId].features = {
      ...(nodes[centerNodeId].features || {}),
      lotCenter: true,
    };

    lot.polygon.forEach((corner) => {
      const cornerNodeId = nodeByKey.get(pointKey(corner));
      if (cornerNodeId === undefined || !eligibleNodeIds.has(cornerNodeId)) {
        return;
      }
      if (centerNodeId === cornerNodeId) {
        return;
      }
      routes.push({
        id: `route:${routes.length}`,
        fromNodeId: centerNodeId,
        toNodeId: cornerNodeId,
        type: "alley",
        length: pointDistance(lot.centroid, corner),
        midpoint: midpointBetween(lot.centroid, corner),
        sourceSegmentId: null,
        leftLotId: lot.id,
        rightLotId: null,
        leftSublotId: null,
        rightSublotId: null,
        features: {
          alley: true,
          lotCenterAlley: true,
          ...(routeFeatureOverrides || {}),
        },
      });
    });
  });

  rebuildNodeRouteIds(nodes, routes);
  return {
    nodes: nodes.map((node) => ({
      ...node,
      type: node.features?.lotCenter ? "lot_center" : classifyNodeType(node, routes),
    })),
    routes,
  };
}

export function stripLotCenterAlleyRoutesFromRouteGraph(routeGraph) {
  const graph = cloneRouteGraph(routeGraph || { nodes: [], routes: [] });
  const keptRoutes = graph.routes.filter((route) => !route.features?.lotCenterAlley);
  const usedNodeIds = new Set();
  keptRoutes.forEach((route) => {
    usedNodeIds.add(route.fromNodeId);
    usedNodeIds.add(route.toNodeId);
  });
  const idByOldId = new Map();
  const nodes = graph.nodes
    .filter((node) => usedNodeIds.has(node.id) && !node.features?.lotCenter)
    .map((node) => {
      const id = idByOldId.size;
      idByOldId.set(node.id, id);
      return { ...node, id, routeIds: [] };
    });
  const routes = keptRoutes
    .filter((route) => idByOldId.has(route.fromNodeId) && idByOldId.has(route.toNodeId))
    .map((route) => ({
      ...route,
      fromNodeId: idByOldId.get(route.fromNodeId),
      toNodeId: idByOldId.get(route.toNodeId),
    }));
  rebuildNodeRouteIds(nodes, routes);
  return {
    nodes: nodes.map((node) => ({
      ...node,
      type: classifyNodeType(node, routes),
    })),
    routes,
  };
}

export function findLotCenterAlleyTargetNodeIds(graph) {
  const routesById = new Map((graph.routes || []).map((route) => [route.id, route]));
  const blockedRouteTypes = new Set(["coast", "river", "sea"]);
  return new Set((graph.nodes || [])
    .filter((node) => {
      const routeTypes = (node.routeIds || []).map((routeId) => routesById.get(routeId)?.type).filter(Boolean);
      if (routeTypes.some((type) => blockedRouteTypes.has(type))) {
        return false;
      }
      return routeTypes.filter((type) => type === "road").length >= 3;
    })
    .map((node) => node.id));
}

function buildVertexIdsByPointKey(vertices) {
  const idsByKey = new Map();
  vertices.forEach((vertex) => {
    const key = pointKey(vertex);
    const ids = idsByKey.get(key) || [];
    ids.push(vertex.id);
    idsByKey.set(key, ids);
  });
  return idsByKey;
}

function buildVertexFeaturesByPointKey(vertices) {
  const featuresByKey = new Map();
  vertices.forEach((vertex) => {
    if (!vertex.features) {
      return;
    }
    const key = pointKey(vertex);
    featuresByKey.set(key, {
      ...(featuresByKey.get(key) || {}),
      ...(vertex.features || {}),
    });
  });
  return featuresByKey;
}

function getOrCreateNode(nodes, nodeByKey, point, vertexIdsByPointKey = new Map(), vertexFeaturesByPointKey = new Map()) {
  const key = pointKey(point);
  const existing = nodeByKey.get(key);
  if (existing !== undefined) {
    mergeSourceVertexIds(nodes[existing], vertexIdsByPointKey.get(key) || []);
    nodes[existing].features = {
      ...(nodes[existing].features || {}),
      ...(vertexFeaturesByPointKey.get(key) || {}),
    };
    return existing;
  }

  const id = nodes.length;
  nodes.push({
    id,
    x: point.x,
    y: point.y,
    routeIds: [],
    type: "junction",
    sourceVertexIds: [...(vertexIdsByPointKey.get(key) || [])],
    features: {
      ...(vertexFeaturesByPointKey.get(key) || {}),
    },
  });
  nodeByKey.set(key, id);
  return id;
}

function mergeSourceVertexIds(node, vertexIds) {
  vertexIds.forEach((vertexId) => {
    if (!node.sourceVertexIds.includes(vertexId)) {
      node.sourceVertexIds.push(vertexId);
    }
  });
}

function rebuildNodeRouteIds(nodes, routes) {
  nodes.forEach((node) => {
    node.routeIds = [];
  });
  routes.forEach((route) => {
    nodes[route.fromNodeId]?.routeIds.push(route.id);
    nodes[route.toNodeId]?.routeIds.push(route.id);
  });
}

function classifySegmentRoute(segment, lotById) {
  if (segment.features?.routeType === "road" || segment.features?.road) {
    return "road";
  }
  if (segment.features?.routeType === "street" || segment.features?.street) {
    return "street";
  }
  if (segment.features?.routeType === "alley" || segment.features?.alley) {
    return "alley";
  }
  if (segment.features?.routeType === "wild" || segment.features?.wild || segment.features?.blockedCrossing) {
    return "wild";
  }
  if (segment.features?.river) {
    return "river";
  }
  if (segment.features?.sea || adjacentLotsAre(segment, lotById, (lot) => lot?.features?.sea)) {
    return "sea";
  }
  if (segment.features?.coast || segmentTouchesSeaAndLand(segment, lotById)) {
    return "coast";
  }
  return "road";
}

function adjacentLotsAre(segment, lotById, predicate) {
  const left = segment.leftLotId === null || segment.leftLotId === undefined ? null : lotById.get(segment.leftLotId);
  const right = segment.rightLotId === null || segment.rightLotId === undefined ? null : lotById.get(segment.rightLotId);
  return Boolean(left && right && predicate(left) && predicate(right));
}

function segmentTouchesSeaAndLand(segment, lotById) {
  const left = segment.leftLotId === null || segment.leftLotId === undefined ? null : lotById.get(segment.leftLotId);
  const right = segment.rightLotId === null || segment.rightLotId === undefined ? null : lotById.get(segment.rightLotId);
  const hasSea = Boolean(left?.features?.sea || right?.features?.sea);
  const hasLand = Boolean(left?.features?.land || right?.features?.land);
  return hasSea && hasLand;
}

function classifyNodeType(node, routes) {
  const connected = node.routeIds
    .map((routeId) => routes.find((route) => route.id === routeId))
    .filter(Boolean);
  const types = new Set(connected.map((route) => route.type));

  if (types.has("river") && (types.has("sea") || types.has("coast"))) {
    return "river_mouth";
  }
  if (types.has("river") && (types.has("road") || types.has("street") || types.has("alley"))) {
    return "river_crossing";
  }
  if (types.has("coast")) {
    return "coast";
  }
  if (types.size === 1 && types.has("alley")) {
    return "alley";
  }
  if (types.size === 1 && types.has("sea")) {
    return "sea";
  }
  if (types.has("road") || types.has("street")) {
    return "road";
  }
  if (types.has("river")) {
    return "river";
  }
  return "junction";
}

function cloneRouteGraph(routeGraph) {
  return {
    nodes: (routeGraph.nodes || []).map((node) => ({
      ...node,
      routeIds: [...(node.routeIds || [])],
      sourceVertexIds: [...(node.sourceVertexIds || [])],
    })),
    routes: (routeGraph.routes || []).map((route) => cloneRoute(route)),
  };
}

function cloneRoute(route) {
  return {
    ...route,
    midpoint: route.midpoint ? clonePoint(route.midpoint) : null,
    features: {
      ...(route.features || {}),
    },
  };
}

function edgeKey(from, to) {
  const fromKey = pointKey(from);
  const toKey = pointKey(to);
  return fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
