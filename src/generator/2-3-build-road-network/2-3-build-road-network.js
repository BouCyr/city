/*
 * WHAT: Promote a minimal parish-center road network over the existing route graph.
 * HOW: Demote physical land roads to alleys, add temporary parish-center connector alleys,
 *      then repeatedly promote the cheapest center-to-unlinked-parish path to roads.
 * WHY: Roads should be the selected parish spine; all other land travel remains alley-scale.
 */

import { clonePoint, pointDistance } from "../map-model.js";
import {
  addLotCenterAlleyRoutesToRouteGraph,
  buildRouteGraph,
  stripLotCenterAlleyRoutesFromRouteGraph,
} from "../route-graph.js";
import { getDefaultRouteCrossingPenalty } from "../route-path.js";

const DISTANCE_EPSILON = 0.0000001;
const ROAD_ROUTE_TYPE = "road";
const STREET_ROUTE_TYPE = "street";
const ALLEY_ROUTE_TYPE = "alley";
const WILD_ROUTE_TYPE = "wild";
const CENTER_CONNECTOR_ROUTE_TYPE = "center_connector";
const STREET_ROUTE_WEIGHT_FACTOR = 1;
const ROAD_ROUTE_WEIGHT_FACTOR = 3;
const ALLEY_ROUTE_WEIGHT_FACTOR = 6;
const BRIDGE_PENALTY_MULTIPLIER = 1.5;
const TEMP_CENTER_ALLEY_FEATURE = "roadNetworkCenterAlley";

export function runBuildRoadNetworkStep(map) {
  if (!Array.isArray(map.parishCenters) || map.parishCenters.length <= 1) {
    return {
      map,
      frameEntries: [{ label: "Step 2.3 / Road network", map }],
    };
  }

  const roadNetwork = buildRoadNetwork(map);
  const nextMap = {
    ...map,
    segments: applyRoadNetworkSegmentFeatures(map.segments || [], roadNetwork.finalRouteGraph.routes, roadNetwork.metadata.blockedCrossingSourceSegmentIds),
    vertices: applyBridgeVertexFeatures(map.vertices || [], roadNetwork.finalRouteGraph.nodes),
    routeGraph: roadNetwork.finalRouteGraph,
    roadNetwork: roadNetwork.metadata,
  };

  return {
    map: nextMap,
    frameEntries: [{ label: "Step 2.3 / Road network", map: nextMap }],
  };
}

export function buildRoadNetwork(map) {
  const baseGraph = stripLotCenterAlleyRoutesFromRouteGraph(map.routeGraph || buildRouteGraph(map));
  const centerLots = resolveParishCenterLots(map);
  const graphWithEligibleCenterLinks = addLotCenterAlleyRoutesToRouteGraph(
    { ...map, routeGraph: baseGraph },
    centerLots,
    { [TEMP_CENTER_ALLEY_FEATURE]: true, routeType: CENTER_CONNECTOR_ROUTE_TYPE },
  );
  const graphWithCenters = demotePhysicalRoadsToAlleys(graphWithEligibleCenterLinks);
  graphWithCenters.parishCenters = map.parishCenters || [];
  const centerParish = findMiddleParishCenter(map.parishCenters || [], map.meta?.size || 1000);
  const centerNodeByParishId = new Map((graphWithCenters.nodes || [])
    .filter((node) => node.type === "lot_center" && node.lotId !== null && node.lotId !== undefined)
    .map((node) => {
      const parishId = findParishIdByLotId(map.parishCenters || [], node.lotId);
      node.parishId = parishId;
      return [parishId, node.id];
    })
    .filter(([parishId]) => parishId !== null && parishId !== undefined));
  const centerNodeId = centerNodeByParishId.get(centerParish?.parishId);
  const roadRouteIds = new Set();
  const streetRouteIds = new Set();
  const bridgeNodeIds = new Set();
  const linkedParishIds = new Set(centerParish ? [centerParish.parishId] : []);
  const iterations = [];
  let crossingPenalty = map.init?.params?.routeCrossingCost ?? getDefaultRouteCrossingPenalty();

  while (centerNodeId !== undefined && linkedParishIds.size < centerNodeByParishId.size) {
    const path = findNearestUnlinkedParishPath(
      graphWithCenters,
      centerNodeId,
      centerNodeByParishId,
      linkedParishIds,
      roadRouteIds,
      bridgeNodeIds,
      crossingPenalty,
    );
    if (!path) {
      break;
    }

    const newBridgeNodeIds = path.nodeIds.filter((nodeId) =>
      isRiverCrossingNode(graphWithCenters.nodes[nodeId]) && !bridgeNodeIds.has(nodeId)
    );
    path.routeIds.forEach((routeId) => {
      const route = graphWithCenters.routes.find((candidate) => candidate.id === routeId);
      if (route?.features?.[TEMP_CENTER_ALLEY_FEATURE]) {
        streetRouteIds.add(routeId);
        route.type = STREET_ROUTE_TYPE;
        route.features = {
          ...(route.features || {}),
          street: true,
          road: false,
          alley: false,
          lotCenterAlley: false,
          [TEMP_CENTER_ALLEY_FEATURE]: false,
          routeType: STREET_ROUTE_TYPE,
        };
        return;
      }
      if (route && isPhysicalLandRoute(route)) {
        roadRouteIds.add(routeId);
        route.type = ROAD_ROUTE_TYPE;
        route.features = {
          ...(route.features || {}),
          road: true,
          alley: false,
          routeType: ROAD_ROUTE_TYPE,
        };
      }
    });
    newBridgeNodeIds.forEach((nodeId) => {
      bridgeNodeIds.add(nodeId);
      graphWithCenters.nodes[nodeId].features = {
        ...(graphWithCenters.nodes[nodeId].features || {}),
        bridge: true,
      };
      (graphWithCenters.nodes[nodeId].routeIds || []).forEach((routeId) => {
        const route = graphWithCenters.routes.find((candidate) => candidate.id === routeId);
        if (route) {
          route.features = { ...(route.features || {}), bridge: true };
        }
      });
    });

    iterations.push({
      parishId: path.parishId,
      parishLetter: path.parishLetter,
      parishName: path.parishName,
      fromParishId: centerParish.parishId,
      distance: path.distance,
      actualLength: path.actualLength,
      crossingPenalty,
      routeIds: path.routeIds.filter((routeId) => {
        const route = graphWithCenters.routes.find((candidate) => candidate.id === routeId);
        return route && (isPhysicalLandRoute(route) || streetRouteIds.has(routeId));
      }),
      nodeIds: path.nodeIds,
      bridgeNodeIds: newBridgeNodeIds,
    });
    linkedParishIds.add(path.parishId);
    if (newBridgeNodeIds.length) {
      crossingPenalty *= BRIDGE_PENALTY_MULTIPLIER ** newBridgeNodeIds.length;
    }
  }

  const finalRouteGraph = stripTemporaryRoadNetworkCenterAlleys(graphWithCenters, streetRouteIds);
  finalRouteGraph.routes.forEach((route) => {
    if (streetRouteIds.has(route.sourceRoadNetworkRouteId ?? route.id) || route.type === STREET_ROUTE_TYPE) {
      route.type = STREET_ROUTE_TYPE;
      route.features = { ...(route.features || {}), street: true, road: false, alley: false, routeType: STREET_ROUTE_TYPE };
      return;
    }
    if (!isPhysicalLandRoute(route)) {
      return;
    }
    if (roadRouteIds.has(route.id)) {
      route.type = ROAD_ROUTE_TYPE;
      route.features = { ...(route.features || {}), road: true, alley: false, routeType: ROAD_ROUTE_TYPE };
      return;
    }
    route.type = ALLEY_ROUTE_TYPE;
    route.features = { ...(route.features || {}), road: false, alley: true, routeType: ALLEY_ROUTE_TYPE };
  });
  finalRouteGraph.nodes.forEach((node) => {
    if (bridgeNodeIds.has(node.sourceRoadNetworkNodeId ?? node.id)) {
      node.features = { ...(node.features || {}), bridge: true };
    }
  });
  const sanitizedRoadNetwork = removeNonBridgeCrossings(finalRouteGraph);
  const finalBridgeNodeIds = finalRouteGraph.nodes
    .filter((node) => node.features?.bridge)
    .map((node) => node.id);
  const streetRoutes = sanitizedRoadNetwork.routeGraph.routes
    .filter((route) => route.type === STREET_ROUTE_TYPE)
    .map((route) => serializeStreetRoute(route, sanitizedRoadNetwork.routeGraph.nodes));

  return {
    finalRouteGraph: sanitizedRoadNetwork.routeGraph,
    metadata: {
      centerParishId: centerParish?.parishId ?? null,
      centerParishLetter: centerParish?.letter ?? null,
      centerParishName: centerParish?.name ?? null,
      linkedParishIds: Array.from(linkedParishIds),
      roadRouteIds: Array.from(roadRouteIds),
      streetRouteIds: streetRoutes.map((route) => route.id),
      streetRoutes,
      bridgeNodeIds: finalBridgeNodeIds,
      blockedCrossingRouteIds: sanitizedRoadNetwork.blockedRouteIds,
      blockedCrossingSourceSegmentIds: sanitizedRoadNetwork.blockedSourceSegmentIds,
      removedCrossingNodeIds: sanitizedRoadNetwork.removedCrossingNodeIds,
      bridgePenaltyMultiplier: BRIDGE_PENALTY_MULTIPLIER,
      iterations,
    },
    traceGraph: graphWithCenters,
  };
}

function demotePhysicalRoadsToAlleys(routeGraph) {
  const routes = (routeGraph.routes || []).map((route) => {
    if (route.type !== ROAD_ROUTE_TYPE) {
      return cloneRoute(route);
    }
    return {
      ...cloneRoute(route),
      type: ALLEY_ROUTE_TYPE,
      features: {
        ...(route.features || {}),
        road: false,
        alley: true,
        routeType: ALLEY_ROUTE_TYPE,
      },
    };
  });
  return {
    nodes: (routeGraph.nodes || []).map((node) => ({ ...node, routeIds: [...(node.routeIds || [])] })),
    routes,
  };
}

function resolveParishCenterLots(map) {
  const lotsById = new Map((map.lots || []).map((lot) => [lot.id, lot]));
  return (map.parishCenters || [])
    .map((center) => lotsById.get(center.lotId))
    .filter(Boolean);
}

function findMiddleParishCenter(parishCenters, mapSize) {
  const middle = { x: mapSize / 2, y: mapSize / 2 };
  return parishCenters
    .filter((center) => Number.isFinite(center.x) && Number.isFinite(center.y))
    .sort((first, second) =>
      pointDistance(first, middle) - pointDistance(second, middle)
      || first.parishId - second.parishId
    )[0] || null;
}

function findParishIdByLotId(parishCenters, lotId) {
  return parishCenters.find((center) => center.lotId === lotId)?.parishId ?? null;
}

function findNearestUnlinkedParishPath(graph, centerNodeId, centerNodeByParishId, linkedParishIds, roadRouteIds, bridgeNodeIds, crossingPenalty) {
  const parishByNodeId = new Map();
  centerNodeByParishId.forEach((nodeId, parishId) => {
    if (!linkedParishIds.has(parishId)) {
      parishByNodeId.set(nodeId, parishId);
    }
  });
  if (!parishByNodeId.size) {
    return null;
  }

  const result = findShortestPathToAnyTarget(graph, centerNodeId, parishByNodeId, roadRouteIds, bridgeNodeIds, crossingPenalty);
  if (!result) {
    return null;
  }
  const parishCenter = graph.parishCenters?.find((center) => center.parishId === result.parishId) || null;
  return {
    ...result,
    parishLetter: parishCenter?.letter ?? null,
    parishName: parishCenter?.name ?? null,
  };
}

function findShortestPathToAnyTarget(graph, startNodeId, parishByNodeId, roadRouteIds, bridgeNodeIds, crossingPenalty) {
  const adjacency = buildRoadNetworkAdjacency(graph, roadRouteIds);
  const distances = new Map([[startNodeId, 0]]);
  const previous = new Map();
  const queue = new MinPriorityQueue();
  queue.push({ nodeId: startNodeId, priority: 0 });
  let targetNodeId = null;

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current || current.priority > (distances.get(current.nodeId) ?? Infinity) + DISTANCE_EPSILON) {
      continue;
    }
    if (parishByNodeId.has(current.nodeId)) {
      targetNodeId = current.nodeId;
      break;
    }

    (adjacency.get(current.nodeId) || []).forEach((edge) => {
      const nextNode = graph.nodes[edge.toNodeId];
      if (!nextNode) {
        return;
      }
      const crossingCost = isRiverCrossingNode(nextNode)
        && !bridgeNodeIds.has(edge.toNodeId)
        && edge.toNodeId !== startNodeId
        ? crossingPenalty
        : 0;
      const nextDistance = current.priority + edge.weight + crossingCost;
      if (nextDistance + DISTANCE_EPSILON >= (distances.get(edge.toNodeId) ?? Infinity)) {
        return;
      }
      distances.set(edge.toNodeId, nextDistance);
      previous.set(edge.toNodeId, { nodeId: current.nodeId, routeId: edge.routeId });
      queue.push({ nodeId: edge.toNodeId, priority: nextDistance });
    });
  }

  if (targetNodeId === null) {
    return null;
  }
  const routeIds = [];
  const nodeIds = [targetNodeId];
  for (let currentId = targetNodeId; currentId !== startNodeId;) {
    const step = previous.get(currentId);
    if (!step) {
      return null;
    }
    routeIds.push(step.routeId);
    nodeIds.push(step.nodeId);
    currentId = step.nodeId;
  }
  routeIds.reverse();
  nodeIds.reverse();
  return {
    parishId: parishByNodeId.get(targetNodeId),
    distance: distances.get(targetNodeId) ?? Infinity,
    actualLength: routeIds.reduce((sum, routeId) => sum + (graph.routes.find((route) => route.id === routeId)?.length || 0), 0),
    routeIds,
    nodeIds,
  };
}

function buildRoadNetworkAdjacency(graph, roadRouteIds) {
  const adjacency = new Map();
  (graph.routes || []).forEach((route) => {
    if (route.type !== ROAD_ROUTE_TYPE && route.type !== STREET_ROUTE_TYPE && route.type !== ALLEY_ROUTE_TYPE) {
      return;
    }
    const weight = getRoadNetworkRouteWeight(route, roadRouteIds);
    appendAdjacency(adjacency, route.fromNodeId, { toNodeId: route.toNodeId, routeId: route.id, weight });
    appendAdjacency(adjacency, route.toNodeId, { toNodeId: route.fromNodeId, routeId: route.id, weight });
  });
  return adjacency;
}

function getRoadNetworkRouteWeight(route, roadRouteIds) {
  if (route.type === STREET_ROUTE_TYPE || route.features?.[TEMP_CENTER_ALLEY_FEATURE]) {
    return (route.length || 0) * STREET_ROUTE_WEIGHT_FACTOR;
  }
  if (route.type === ROAD_ROUTE_TYPE || roadRouteIds.has(route.id)) {
    return (route.length || 0) * ROAD_ROUTE_WEIGHT_FACTOR;
  }
  return (route.length || 0) * ALLEY_ROUTE_WEIGHT_FACTOR;
}

function appendAdjacency(adjacency, nodeId, edge) {
  const edges = adjacency.get(nodeId) || [];
  edges.push(edge);
  adjacency.set(nodeId, edges);
}

function isPhysicalLandRoute(route) {
  return Boolean(route && !route.features?.lotCenterAlley && route.sourceSegmentId !== null && route.sourceSegmentId !== undefined && (route.type === ROAD_ROUTE_TYPE || route.type === ALLEY_ROUTE_TYPE));
}

function isRiverCrossingNode(node) {
  return node?.type === "river_crossing";
}

function stripTemporaryRoadNetworkCenterAlleys(routeGraph, streetRouteIds) {
  const keptRoutes = (routeGraph.routes || []).filter((route) => !route.features?.[TEMP_CENTER_ALLEY_FEATURE] || streetRouteIds.has(route.id));
  const usedNodeIds = new Set();
  keptRoutes.forEach((route) => {
    usedNodeIds.add(route.fromNodeId);
    usedNodeIds.add(route.toNodeId);
  });
  const idByOldId = new Map();
  const nodes = (routeGraph.nodes || [])
    .filter((node) => usedNodeIds.has(node.id))
    .map((node) => {
      const id = idByOldId.size;
      idByOldId.set(node.id, id);
      return { ...node, id, sourceRoadNetworkNodeId: node.id, routeIds: [] };
    });
  const routes = keptRoutes
    .filter((route) => idByOldId.has(route.fromNodeId) && idByOldId.has(route.toNodeId))
    .map((route) => ({
      ...route,
      sourceRoadNetworkRouteId: route.id,
      fromNodeId: idByOldId.get(route.fromNodeId),
      toNodeId: idByOldId.get(route.toNodeId),
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  routes.forEach((route) => {
    if (nodeIds.has(route.fromNodeId)) {
      nodes.find((node) => node.id === route.fromNodeId)?.routeIds.push(route.id);
    }
    if (nodeIds.has(route.toNodeId)) {
      nodes.find((node) => node.id === route.toNodeId)?.routeIds.push(route.id);
    }
  });
  return { nodes, routes };
}

function removeNonBridgeCrossings(routeGraph) {
  const blockedNodeIds = new Set((routeGraph.nodes || [])
    .filter((node) => node.type === "river_crossing" && !node.features?.bridge)
    .map((node) => node.id));
  if (!blockedNodeIds.size) {
    return { routeGraph, blockedRouteIds: [], blockedSourceSegmentIds: [], removedCrossingNodeIds: [] };
  }

  const wildRouteIds = new Set();
  const blockedSourceSegmentIds = new Set();
  const routes = (routeGraph.routes || [])
    .map((route) => {
      const touchesBlockedCrossing = blockedNodeIds.has(route.fromNodeId) || blockedNodeIds.has(route.toNodeId);
      const isRemovedApproach = touchesBlockedCrossing && (route.type === ALLEY_ROUTE_TYPE || route.type === STREET_ROUTE_TYPE || route.type === ROAD_ROUTE_TYPE);
      if (isRemovedApproach) {
        wildRouteIds.add(route.id);
        if (route.sourceSegmentId !== null && route.sourceSegmentId !== undefined) {
          blockedSourceSegmentIds.add(route.sourceSegmentId);
        }
        return {
          ...route,
          type: WILD_ROUTE_TYPE,
          features: {
            ...(route.features || {}),
            road: false,
            street: false,
            alley: false,
            wild: true,
            blockedCrossing: true,
            routeType: WILD_ROUTE_TYPE,
          },
        };
      }
      return route;
    });
  const nodes = (routeGraph.nodes || []).map((node) => ({
    ...node,
    type: blockedNodeIds.has(node.id) ? "river" : node.type,
    routeIds: [],
    features: blockedNodeIds.has(node.id)
      ? { ...(node.features || {}), blockedCrossing: true, bridge: false }
      : { ...(node.features || {}) },
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  routes.forEach((route) => {
    if (nodeIds.has(route.fromNodeId)) {
      nodes.find((node) => node.id === route.fromNodeId)?.routeIds.push(route.id);
    }
    if (nodeIds.has(route.toNodeId)) {
      nodes.find((node) => node.id === route.toNodeId)?.routeIds.push(route.id);
    }
  });

  return {
    routeGraph: { nodes, routes },
    blockedRouteIds: Array.from(wildRouteIds),
    blockedSourceSegmentIds: Array.from(blockedSourceSegmentIds),
    removedCrossingNodeIds: Array.from(blockedNodeIds),
  };
}

function applyRoadNetworkSegmentFeatures(segments, routes, blockedSourceSegmentIds = []) {
  const routeBySegmentId = new Map();
  const bridgeSegmentIds = new Set();
  const blockedSegmentIds = new Set(blockedSourceSegmentIds);
  routes.forEach((route) => {
    if (route.sourceSegmentId !== null && route.sourceSegmentId !== undefined) {
      routeBySegmentId.set(route.sourceSegmentId, route);
      if (route.features?.bridge) {
        bridgeSegmentIds.add(route.sourceSegmentId);
      }
    }
  });
  return segments.map((segment) => {
    const route = routeBySegmentId.get(segment.id);
    const bridge = bridgeSegmentIds.has(segment.id);
    const blocked = blockedSegmentIds.has(segment.id);
    if (blocked) {
      return {
        ...segment,
        features: {
          ...(segment.features || {}),
          road: false,
          street: false,
          alley: false,
          wild: true,
          blockedCrossing: true,
          routeType: WILD_ROUTE_TYPE,
        },
      };
    }
    if (!route || (route.type !== ROAD_ROUTE_TYPE && route.type !== STREET_ROUTE_TYPE && route.type !== ALLEY_ROUTE_TYPE)) {
      return bridge
        ? { ...segment, features: { ...(segment.features || {}), bridge: true } }
        : segment;
    }
    return {
      ...segment,
      features: {
        ...(segment.features || {}),
        road: route.type === ROAD_ROUTE_TYPE,
        street: route.type === STREET_ROUTE_TYPE,
        alley: route.type === ALLEY_ROUTE_TYPE,
        routeType: route.type,
        bridge: bridge || Boolean(segment.features?.bridge),
      },
    };
  });
}

function serializeStreetRoute(route, nodes) {
  const from = nodes.find((node) => node.id === route.fromNodeId);
  const to = nodes.find((node) => node.id === route.toNodeId);
  return {
    id: route.id,
    from: from ? clonePoint(from) : null,
    to: to ? clonePoint(to) : null,
    length: route.length || 0,
    midpoint: route.midpoint ? clonePoint(route.midpoint) : null,
    leftLotId: route.leftLotId ?? null,
    rightLotId: route.rightLotId ?? null,
    fromNode: serializeStreetNode(from),
    toNode: serializeStreetNode(to),
    features: {
      ...(route.features || {}),
      street: true,
      routeType: STREET_ROUTE_TYPE,
    },
  };
}

function serializeStreetNode(node) {
  if (!node) {
    return null;
  }
  return {
    x: node.x,
    y: node.y,
    type: node.type,
    lotId: node.lotId ?? null,
    parishId: node.parishId ?? null,
    sourceVertexIds: [...(node.sourceVertexIds || [])],
    features: {
      ...(node.features || {}),
    },
  };
}

function applyBridgeVertexFeatures(vertices, nodes) {
  const bridgeVertexIds = new Set();
  nodes.forEach((node) => {
    if (!node.features?.bridge) {
      return;
    }
    (node.sourceVertexIds || []).forEach((vertexId) => bridgeVertexIds.add(vertexId));
  });
  if (!bridgeVertexIds.size) {
    return vertices;
  }
  return vertices.map((vertex) => bridgeVertexIds.has(vertex.id)
    ? { ...vertex, features: { ...(vertex.features || {}), bridge: true } }
    : vertex);
}

function cloneRoute(route) {
  return {
    ...route,
    midpoint: route.midpoint ? clonePoint(route.midpoint) : route.midpoint,
    features: { ...(route.features || {}) },
  };
}

class MinPriorityQueue {
  constructor() {
    this.heap = [];
  }

  push(item) {
    this.heap.push(item);
    this.bubbleUp();
  }

  pop() {
    if (this.heap.length === 0) return null;
    if (this.heap.length === 1) return this.heap.pop();
    const first = this.heap[0];
    this.heap[0] = this.heap.pop();
    this.bubbleDown();
    return first;
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  bubbleUp() {
    let index = this.heap.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[parentIndex].priority <= this.heap[index].priority) break;
      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }

  bubbleDown() {
    let index = 0;
    while (true) {
      const leftIndex = (index * 2) + 1;
      const rightIndex = (index * 2) + 2;
      let smallestIndex = index;
      if (leftIndex < this.heap.length && this.heap[leftIndex].priority < this.heap[smallestIndex].priority) {
        smallestIndex = leftIndex;
      }
      if (rightIndex < this.heap.length && this.heap[rightIndex].priority < this.heap[smallestIndex].priority) {
        smallestIndex = rightIndex;
      }
      if (smallestIndex === index) break;
      [this.heap[smallestIndex], this.heap[index]] = [this.heap[index], this.heap[smallestIndex]];
      index = smallestIndex;
    }
  }
}
