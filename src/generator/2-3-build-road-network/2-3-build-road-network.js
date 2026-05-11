/*
 * WHAT: Promote a minimal parish-center road network over the existing route graph.
 * HOW: Demote physical land roads to alleys, add temporary parish-center connector alleys,
 *      then repeatedly promote the cheapest center-to-unlinked-parish path to roads.
 * WHY: Roads should be the selected parish spine; all other land travel remains alley-scale.
 */

import { clonePoint, midpointBetween, pointDistance } from "../map-model.js";
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
const BOUNDARY_CONNECTOR_ROUTE_TYPE = "boundary_connector";
const STREET_ROUTE_WEIGHT_FACTOR = 1;
const ROAD_ROUTE_WEIGHT_FACTOR = 3;
const ALLEY_ROUTE_WEIGHT_FACTOR = 6;
const PARISH_BOUNDARY_ROUTE_WEIGHT_FACTOR = 2;
const BRIDGE_PENALTY_MULTIPLIER = 1.5;
const TEMP_CENTER_ALLEY_FEATURE = "roadNetworkCenterAlley";
const TEMP_BOUNDARY_ALLEY_FEATURE = "roadNetworkBoundaryAlley";
const DEFAULT_ROAD_NETWORK_ALGORITHM = "boundary_connectors";

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
  const algorithm = normalizeRoadNetworkAlgorithm(map.init?.params?.stepAlgorithms?.roadNetwork);
  const useBoundaryConnectors = algorithm === "boundary_connectors";
  const baseGraph = stripLotCenterAlleyRoutesFromRouteGraph(map.routeGraph || buildRouteGraph(map));
  const centerLots = resolveParishCenterLots(map);
  const graphWithEligibleCenterLinks = addLotCenterAlleyRoutesToRouteGraph(
    { ...map, routeGraph: baseGraph },
    centerLots,
    { [TEMP_CENTER_ALLEY_FEATURE]: true, routeType: CENTER_CONNECTOR_ROUTE_TYPE },
  );
  const demotedGraph = demotePhysicalRoadsToAlleys(graphWithEligibleCenterLinks);
  const parishBoundaryRouteIds = useBoundaryConnectors ? findParishBoundaryRouteIds(demotedGraph, map.lots || []) : new Set();
  const graphWithCenters = useBoundaryConnectors
    ? addBoundaryLotVirtualAlleys(demotedGraph, map.lots || [], parishBoundaryRouteIds)
    : demotedGraph;
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
  const virtualRoadRouteIds = new Set();
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
      parishBoundaryRouteIds,
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
      if (route?.features?.[TEMP_BOUNDARY_ALLEY_FEATURE]) {
        virtualRoadRouteIds.add(routeId);
        route.type = ROAD_ROUTE_TYPE;
        route.features = {
          ...(route.features || {}),
          road: true,
          street: false,
          alley: false,
          [TEMP_BOUNDARY_ALLEY_FEATURE]: false,
          routeType: ROAD_ROUTE_TYPE,
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
        return route && (isPhysicalLandRoute(route) || streetRouteIds.has(routeId) || virtualRoadRouteIds.has(routeId));
      }),
      nodeIds: path.nodeIds,
      bridgeNodeIds: newBridgeNodeIds,
    });
    linkedParishIds.add(path.parishId);
    if (newBridgeNodeIds.length) {
      crossingPenalty *= BRIDGE_PENALTY_MULTIPLIER ** newBridgeNodeIds.length;
    }
  }

  const finalRouteGraph = stripTemporaryRoadNetworkTemporaryAlleys(graphWithCenters, streetRouteIds, virtualRoadRouteIds);
  finalRouteGraph.routes.forEach((route) => {
    if (streetRouteIds.has(route.sourceRoadNetworkRouteId ?? route.id) || route.type === STREET_ROUTE_TYPE) {
      route.type = STREET_ROUTE_TYPE;
      route.features = { ...(route.features || {}), street: true, road: false, alley: false, routeType: STREET_ROUTE_TYPE };
      return;
    }
    if (virtualRoadRouteIds.has(route.sourceRoadNetworkRouteId ?? route.id)) {
      route.type = ROAD_ROUTE_TYPE;
      route.features = { ...(route.features || {}), road: true, street: false, alley: false, [TEMP_BOUNDARY_ALLEY_FEATURE]: false, routeType: ROAD_ROUTE_TYPE };
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
    route.type = WILD_ROUTE_TYPE;
    route.features = { ...(route.features || {}), road: false, street: false, alley: false, wild: true, routeType: WILD_ROUTE_TYPE };
  });
  finalRouteGraph.nodes.forEach((node) => {
    if (bridgeNodeIds.has(node.sourceRoadNetworkNodeId ?? node.id)) {
      node.features = { ...(node.features || {}), bridge: true };
    }
  });
  const sanitizedRoadNetwork = convertRemainingAlleysToWild(removeNonBridgeCrossings(finalRouteGraph));
  const finalBridgeNodeIds = finalRouteGraph.nodes
    .filter((node) => node.features?.bridge)
    .map((node) => node.id);
  const streetRoutes = sanitizedRoadNetwork.routeGraph.routes
    .filter((route) => route.type === STREET_ROUTE_TYPE)
    .map((route) => serializeStreetRoute(route, sanitizedRoadNetwork.routeGraph.nodes));
  const virtualRoadRoutes = sanitizedRoadNetwork.routeGraph.routes
    .filter((route) => route.type === ROAD_ROUTE_TYPE && route.features?.roadNetworkVirtualRoad)
    .map((route) => serializeStoredRoute(route, sanitizedRoadNetwork.routeGraph.nodes, ROAD_ROUTE_TYPE));

  return {
    finalRouteGraph: sanitizedRoadNetwork.routeGraph,
    metadata: {
      centerParishId: centerParish?.parishId ?? null,
      centerParishLetter: centerParish?.letter ?? null,
      centerParishName: centerParish?.name ?? null,
      algorithm,
      linkedParishIds: Array.from(linkedParishIds),
      roadRouteIds: Array.from(roadRouteIds),
      streetRouteIds: streetRoutes.map((route) => route.id),
      streetRoutes,
      virtualRoadRouteIds: virtualRoadRoutes.map((route) => route.id),
      virtualRoadRoutes,
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

function normalizeRoadNetworkAlgorithm(value) {
  return value === "parish_center_spine" ? value : DEFAULT_ROAD_NETWORK_ALGORITHM;
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

function findParishBoundaryRouteIds(routeGraph, lots) {
  const lotById = new Map((lots || []).map((lot) => [lot.id, lot]));
  return new Set((routeGraph.routes || [])
    .filter((route) => routeIsBetweenDifferentLandParishes(route, lotById))
    .map((route) => route.id));
}

function addBoundaryLotVirtualAlleys(routeGraph, lots, parishBoundaryRouteIds) {
  if (!parishBoundaryRouteIds.size) {
    return routeGraph;
  }

  const lotById = new Map((lots || []).map((lot) => [lot.id, lot]));
  const nodes = (routeGraph.nodes || []).map((node) => ({
    ...node,
    routeIds: [...(node.routeIds || [])],
    sourceVertexIds: [...(node.sourceVertexIds || [])],
    features: { ...(node.features || {}) },
  }));
  const routes = (routeGraph.routes || []).map((route) => cloneRoute(route));
  const nodeByKey = new Map(nodes.map((node) => [pointKey(node), node.id]));
  const boundaryNodeIdsByLotId = new Map();
  const landNodeIdsByLotId = new Map();

  routes.forEach((route) => {
    const lotIds = getLandRouteLotIds(route, lotById);
    if (!lotIds.length) {
      return;
    }
    const endpointIds = [route.fromNodeId, route.toNodeId].filter((nodeId) => nodes[nodeId]);
    if (!endpointIds.length) {
      return;
    }
    if (parishBoundaryRouteIds.has(route.id)) {
      lotIds.forEach((lotId) => addSetValues(boundaryNodeIdsByLotId, lotId, endpointIds));
      return;
    }
    if (route.type === COAST_ROUTE_TYPE || route.type === RIVER_ROUTE_TYPE || route.type === SEA_ROUTE_TYPE || route.type === WILD_ROUTE_TYPE) {
      return;
    }
    if (route.type === ROAD_ROUTE_TYPE || route.type === ALLEY_ROUTE_TYPE || route.type === STREET_ROUTE_TYPE) {
      lotIds.forEach((lotId) => addSetValues(landNodeIdsByLotId, lotId, endpointIds));
    }
  });

  const virtualRouteKeySet = new Set();
  Array.from(boundaryNodeIdsByLotId.keys())
    .sort((first, second) => first - second)
    .forEach((lotId) => {
      const lot = lotById.get(lotId);
      if (!lot?.features?.land || lot.features?.sea || !lot.centroid) {
        return;
      }
      const boundaryNodeIds = Array.from(boundaryNodeIdsByLotId.get(lotId) || []).sort((first, second) => first - second);
      const boundaryNodeIdSet = new Set(boundaryNodeIds);
      const internalNodeIds = Array.from(landNodeIdsByLotId.get(lotId) || [])
        .filter((nodeId) => !boundaryNodeIdSet.has(nodeId))
        .sort((first, second) => first - second);
      if (!boundaryNodeIds.length || !internalNodeIds.length) {
        return;
      }

      const centerNodeId = getOrCreateBoundaryLotCenterNode(nodes, nodeByKey, lot);

      boundaryNodeIds.forEach((boundaryNodeId) => {
        appendBoundaryLotVirtualRoute(routes, nodes, virtualRouteKeySet, lotId, boundaryNodeId, centerNodeId);
      });
      internalNodeIds.forEach((internalNodeId) => {
        appendBoundaryLotVirtualRoute(routes, nodes, virtualRouteKeySet, lotId, centerNodeId, internalNodeId);
      });
    });

  return { nodes, routes };
}

function getOrCreateBoundaryLotCenterNode(nodes, nodeByKey, lot) {
  const key = pointKey(lot.centroid);
  const existingId = nodeByKey.get(key);
  if (existingId !== undefined) {
    nodes[existingId].type = "lot_center";
    nodes[existingId].lotId = lot.id;
    nodes[existingId].features = {
      ...(nodes[existingId].features || {}),
      lotCenter: true,
      roadNetworkBoundaryCenter: true,
    };
    return existingId;
  }

  const id = nodes.length;
  nodes.push({
    id,
    x: lot.centroid.x,
    y: lot.centroid.y,
    routeIds: [],
    type: "lot_center",
    lotId: lot.id,
    parishId: lot.parishId ?? null,
    sourceVertexIds: [],
    features: {
      lotCenter: true,
      roadNetworkBoundaryCenter: true,
    },
  });
  nodeByKey.set(key, id);
  return id;
}

function appendBoundaryLotVirtualRoute(routes, nodes, virtualRouteKeySet, lotId, fromNodeId, toNodeId) {
  if (fromNodeId === toNodeId) {
    return;
  }
  const pairKey = routePairKey(fromNodeId, toNodeId);
  if (virtualRouteKeySet.has(pairKey)) {
    return;
  }
  virtualRouteKeySet.add(pairKey);
  const from = nodes[fromNodeId];
  const to = nodes[toNodeId];
  const route = {
    id: `route:${routes.length}`,
    fromNodeId,
    toNodeId,
    type: ALLEY_ROUTE_TYPE,
    length: pointDistance(from, to),
    midpoint: midpointBetween(from, to),
    sourceSegmentId: null,
    leftLotId: lotId,
    rightLotId: null,
    leftSublotId: null,
    rightSublotId: null,
    features: {
      alley: true,
      roadNetworkVirtualRoad: true,
      [TEMP_BOUNDARY_ALLEY_FEATURE]: true,
      routeType: BOUNDARY_CONNECTOR_ROUTE_TYPE,
    },
  };
  routes.push(route);
  nodes[fromNodeId].routeIds.push(route.id);
  nodes[toNodeId].routeIds.push(route.id);
}

const COAST_ROUTE_TYPE = "coast";
const RIVER_ROUTE_TYPE = "river";
const SEA_ROUTE_TYPE = "sea";

function routeIsBetweenDifferentLandParishes(route, lotById) {
  if (!isPhysicalLandRoute(route)) {
    return false;
  }
  const leftLot = route.leftLotId === null || route.leftLotId === undefined ? null : lotById.get(route.leftLotId);
  const rightLot = route.rightLotId === null || route.rightLotId === undefined ? null : lotById.get(route.rightLotId);
  const leftParishId = leftLot?.parishId;
  const rightParishId = rightLot?.parishId;
  return Boolean(
    leftLot?.features?.land
    && rightLot?.features?.land
    && !leftLot.features?.sea
    && !rightLot.features?.sea
    && leftParishId !== null
    && leftParishId !== undefined
    && rightParishId !== null
    && rightParishId !== undefined
    && leftParishId !== rightParishId
  );
}

function getLandRouteLotIds(route, lotById) {
  return [route.leftLotId, route.rightLotId]
    .filter((lotId) => lotId !== null && lotId !== undefined)
    .filter((lotId, index, lotIds) => lotIds.indexOf(lotId) === index)
    .filter((lotId) => {
      const lot = lotById.get(lotId);
      return lot?.features?.land && !lot.features?.sea;
    });
}

function addSetValues(map, key, values) {
  const set = map.get(key) || new Set();
  values.forEach((value) => set.add(value));
  map.set(key, set);
}

function routePairKey(firstNodeId, secondNodeId) {
  return firstNodeId < secondNodeId ? `${firstNodeId}:${secondNodeId}` : `${secondNodeId}:${firstNodeId}`;
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
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

function findNearestUnlinkedParishPath(graph, centerNodeId, centerNodeByParishId, linkedParishIds, roadRouteIds, bridgeNodeIds, crossingPenalty, parishBoundaryRouteIds = new Set()) {
  const parishByNodeId = new Map();
  centerNodeByParishId.forEach((nodeId, parishId) => {
    if (!linkedParishIds.has(parishId)) {
      parishByNodeId.set(nodeId, parishId);
    }
  });
  if (!parishByNodeId.size) {
    return null;
  }

  const result = findShortestPathToAnyTarget(graph, centerNodeId, parishByNodeId, roadRouteIds, bridgeNodeIds, crossingPenalty, parishBoundaryRouteIds);
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

function findShortestPathToAnyTarget(graph, startNodeId, parishByNodeId, roadRouteIds, bridgeNodeIds, crossingPenalty, parishBoundaryRouteIds = new Set()) {
  const adjacency = buildRoadNetworkAdjacency(graph, roadRouteIds, parishBoundaryRouteIds);
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

function buildRoadNetworkAdjacency(graph, roadRouteIds, parishBoundaryRouteIds = new Set()) {
  const adjacency = new Map();
  (graph.routes || []).forEach((route) => {
    if (route.type !== ROAD_ROUTE_TYPE && route.type !== STREET_ROUTE_TYPE && route.type !== ALLEY_ROUTE_TYPE) {
      return;
    }
    const weight = getRoadNetworkRouteWeight(route, roadRouteIds, parishBoundaryRouteIds);
    appendAdjacency(adjacency, route.fromNodeId, { toNodeId: route.toNodeId, routeId: route.id, weight });
    appendAdjacency(adjacency, route.toNodeId, { toNodeId: route.fromNodeId, routeId: route.id, weight });
  });
  return adjacency;
}

function getRoadNetworkRouteWeight(route, roadRouteIds, parishBoundaryRouteIds = new Set()) {
  const boundaryMultiplier = parishBoundaryRouteIds.has(route.id) || parishBoundaryRouteIds.has(route.sourceRoadNetworkRouteId)
    ? PARISH_BOUNDARY_ROUTE_WEIGHT_FACTOR
    : 1;
  if (route.type === STREET_ROUTE_TYPE || route.features?.[TEMP_CENTER_ALLEY_FEATURE]) {
    return (route.length || 0) * STREET_ROUTE_WEIGHT_FACTOR;
  }
  if (route.type === ROAD_ROUTE_TYPE || roadRouteIds.has(route.id)) {
    return (route.length || 0) * ROAD_ROUTE_WEIGHT_FACTOR * boundaryMultiplier;
  }
  return (route.length || 0) * ALLEY_ROUTE_WEIGHT_FACTOR * boundaryMultiplier;
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

function stripTemporaryRoadNetworkTemporaryAlleys(routeGraph, streetRouteIds, virtualRoadRouteIds) {
  const keptRoutes = (routeGraph.routes || []).filter((route) => {
    if (route.features?.[TEMP_CENTER_ALLEY_FEATURE] && !streetRouteIds.has(route.id)) {
      return false;
    }
    if (route.features?.[TEMP_BOUNDARY_ALLEY_FEATURE] && !virtualRoadRouteIds.has(route.id)) {
      return false;
    }
    return true;
  });
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

function convertRemainingAlleysToWild(roadNetwork) {
  const routes = (roadNetwork.routeGraph.routes || []).map((route) => {
    if (route.type !== ALLEY_ROUTE_TYPE) {
      return route;
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
        routeType: WILD_ROUTE_TYPE,
      },
    };
  });

  return {
    ...roadNetwork,
    routeGraph: {
      ...roadNetwork.routeGraph,
      routes,
    },
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
    if (!route || (route.type !== ROAD_ROUTE_TYPE && route.type !== STREET_ROUTE_TYPE && route.type !== ALLEY_ROUTE_TYPE && route.type !== WILD_ROUTE_TYPE)) {
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
        wild: route.type === WILD_ROUTE_TYPE,
        routeType: route.type,
        bridge: bridge || Boolean(segment.features?.bridge),
      },
    };
  });
}

function serializeStreetRoute(route, nodes) {
  return serializeStoredRoute(route, nodes, STREET_ROUTE_TYPE);
}

function serializeStoredRoute(route, nodes, routeType) {
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
    fromNode: serializeStoredNode(from),
    toNode: serializeStoredNode(to),
    features: {
      ...(route.features || {}),
      road: routeType === ROAD_ROUTE_TYPE,
      street: routeType === STREET_ROUTE_TYPE,
      alley: false,
      routeType,
    },
  };
}

function serializeStoredNode(node) {
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
