/*
 * WHAT: Smooth road and street route chains after parish-border smoothing.
 * HOW: Trace road/street chains through the route graph, smooth unpinned chain nodes, and store sampled paths.
 * WHY: Selected road network paths should read as continuous drawn routes instead of angular graph edges.
 */

import {
  DEFAULT_SEGMENT_LENGTH,
  clonePoint,
  midpointBetween,
  normalizePolyline,
  pointDistance,
  polylineLength,
} from "../map-model.js";
import { buildRouteGraph } from "../route-graph.js";
import { appendStoredRoadNetworkRoutes } from "../road-network-stored-routes.js";
import { buildSmoothedSegmentPaths } from "../polyline-smoothing.js";

const ROAD_TYPES = new Set(["road", "street"]);
const POINT_KEY_DIGITS = 4;

export function runSmoothRoadNetworkStep(map) {
  if (!Array.isArray(map.routeGraph?.routes) || !Array.isArray(map.routeGraph?.nodes)) {
    return {
      map,
      frameEntries: [{ label: "Step 2.5 / Road smoothing", map }],
    };
  }

  const smoothing = buildRoadSmoothing(map.routeGraph);
  const nextSegments = applySmoothedRoutePathsToSegments(map.segments || [], smoothing.pathBySourceSegmentId);
  const nextRoadNetwork = applySmoothedRoutePathsToRoadNetwork(map.roadNetwork, smoothing.pathBySourceRoadNetworkRouteId);
  const baseMap = {
    ...map,
    segments: nextSegments,
    roadNetwork: nextRoadNetwork,
  };
  const routeGraph = appendStoredRoadNetworkRoutes(buildRouteGraph(baseMap), baseMap, [
    ...(nextRoadNetwork?.streetRoutes || []),
    ...(nextRoadNetwork?.virtualRoadRoutes || []),
  ]);
  const nextMap = {
    ...baseMap,
    routeGraph,
    roadSmoothing: {
      routeIds: smoothing.routeIds,
      chainCount: smoothing.chainCount,
    },
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.5 / Road smoothing",
        map: nextMap,
      },
    ],
  };
}

function buildRoadSmoothing(routeGraph) {
  const routesById = new Map((routeGraph.routes || []).map((route) => [route.id, route]));
  const roadRoutes = (routeGraph.routes || [])
    .filter((route) => ROAD_TYPES.has(route.type))
    .sort((first, second) => String(first.id).localeCompare(String(second.id)));
  const roadRouteIdsByNodeId = new Map();
  roadRoutes.forEach((route) => {
    pushMapValue(roadRouteIdsByNodeId, route.fromNodeId, route.id);
    pushMapValue(roadRouteIdsByNodeId, route.toNodeId, route.id);
  });
  roadRouteIdsByNodeId.forEach((routeIds) => {
    routeIds.sort((first, second) => String(first).localeCompare(String(second)));
  });

  const protectedNodeIds = findProtectedRoadNodeIds(routeGraph, roadRouteIdsByNodeId);
  const visitedRouteIds = new Set();
  const pathByRouteId = new Map();
  let chainCount = 0;

  Array.from(roadRouteIdsByNodeId.keys())
    .sort((first, second) => first - second)
    .filter((nodeId) => protectedNodeIds.has(nodeId) || (roadRouteIdsByNodeId.get(nodeId) || []).length !== 2)
    .forEach((nodeId) => {
      (roadRouteIdsByNodeId.get(nodeId) || []).forEach((routeId) => {
        if (visitedRouteIds.has(routeId)) {
          return;
        }
        const chain = traceRoadChain(nodeId, routeId, routeGraph, routesById, roadRouteIdsByNodeId, protectedNodeIds, visitedRouteIds);
        if (applySmoothedRoadChain(chain, routeGraph, protectedNodeIds, pathByRouteId)) {
          chainCount += 1;
        }
      });
    });

  roadRoutes.forEach((route) => {
    if (visitedRouteIds.has(route.id)) {
      return;
    }
    const chain = traceRoadChain(route.fromNodeId, route.id, routeGraph, routesById, roadRouteIdsByNodeId, new Set([route.fromNodeId]), visitedRouteIds);
    if (applySmoothedRoadChain(chain, routeGraph, protectedNodeIds, pathByRouteId)) {
      chainCount += 1;
    }
  });

  const pathBySourceSegmentId = new Map();
  const pathBySourceRoadNetworkRouteId = new Map();
  pathByRouteId.forEach((path, routeId) => {
    const route = routesById.get(routeId);
    if (!route) {
      return;
    }
    if (route.sourceSegmentId !== null && route.sourceSegmentId !== undefined) {
      pathBySourceSegmentId.set(route.sourceSegmentId, path);
    }
    const storedRouteId = route.sourceRoadNetworkRouteId ?? route.id;
    if (route.sourceSegmentId === null || route.sourceSegmentId === undefined) {
      pathBySourceRoadNetworkRouteId.set(storedRouteId, path);
    }
  });

  return {
    pathBySourceSegmentId,
    pathBySourceRoadNetworkRouteId,
    routeIds: Array.from(pathByRouteId.keys()),
    chainCount,
  };
}

function findProtectedRoadNodeIds(routeGraph, roadRouteIdsByNodeId) {
  return new Set((routeGraph.nodes || [])
    .filter((node) => {
      const roadDegree = (roadRouteIdsByNodeId.get(node.id) || []).length;
      return roadDegree !== 2
        || node.type === "river_crossing"
        || node.type === "river_mouth"
        || node.type === "coast"
        || node.type === "sea"
        || node.type === "river"
        || node.features?.bridge
        || node.features?.lotCenter;
    })
    .map((node) => node.id));
}

function traceRoadChain(startNodeId, startRouteId, routeGraph, routesById, roadRouteIdsByNodeId, stopNodeIds, visitedRouteIds) {
  const nodeIds = [startNodeId];
  const routeIds = [];
  let currentNodeId = startNodeId;
  let currentRouteId = startRouteId;

  while (currentRouteId !== null && currentRouteId !== undefined && !visitedRouteIds.has(currentRouteId)) {
    const route = routesById.get(currentRouteId);
    if (!route) {
      break;
    }
    visitedRouteIds.add(currentRouteId);
    routeIds.push(currentRouteId);
    const nextNodeId = route.fromNodeId === currentNodeId ? route.toNodeId : route.fromNodeId;
    nodeIds.push(nextNodeId);
    if (nextNodeId === startNodeId || stopNodeIds.has(nextNodeId)) {
      break;
    }
    const nextRouteId = (roadRouteIdsByNodeId.get(nextNodeId) || [])
      .find((routeId) => routeId !== currentRouteId && !visitedRouteIds.has(routeId));
    currentNodeId = nextNodeId;
    currentRouteId = nextRouteId ?? null;
  }

  return { nodeIds, routeIds };
}

function applySmoothedRoadChain(chain, routeGraph, protectedNodeIds, pathByRouteId) {
  if (!chain || chain.routeIds.length < 1 || chain.nodeIds.length < 2) {
    return false;
  }
  const points = chain.nodeIds.map((nodeId) => routeGraph.nodes.find((node) => node.id === nodeId)).filter(Boolean);
  if (points.length !== chain.nodeIds.length) {
    return false;
  }
  const pinnedPointKeys = new Set(chain.nodeIds
    .filter((nodeId, index) => index === 0 || index === chain.nodeIds.length - 1 || protectedNodeIds.has(nodeId))
    .map((nodeId) => pointKey(routeGraph.nodes.find((node) => node.id === nodeId))));
  const segmentPaths = buildSmoothedSegmentPaths(points, pinnedPointKeys, DEFAULT_SEGMENT_LENGTH);
  if (segmentPaths.length !== chain.routeIds.length) {
    return false;
  }
  chain.routeIds.forEach((routeId, index) => {
    const route = routeGraph.routes.find((candidate) => candidate.id === routeId);
    const path = orientPathForRoute(normalizePolyline(segmentPaths[index] || []), route, routeGraph.nodes);
    if (path.length >= 2) {
      pathByRouteId.set(routeId, path);
    }
  });
  return true;
}

function applySmoothedRoutePathsToSegments(segments, pathBySourceSegmentId) {
  if (!pathBySourceSegmentId.size) {
    return segments;
  }
  return segments.map((segment) => {
    const path = pathBySourceSegmentId.get(segment.id);
    if (!path || path.length < 2) {
      return segment;
    }
    return {
      ...segment,
      from: clonePoint(path[0]),
      to: clonePoint(path[path.length - 1]),
      midpoint: midpointBetween(path[0], path[path.length - 1]),
      length: polylineLength(path),
      path: path.map((point) => clonePoint(point)),
      features: {
        ...(segment.features || {}),
        roadSmoothed: true,
      },
    };
  });
}

function applySmoothedRoutePathsToRoadNetwork(roadNetwork, pathBySourceRoadNetworkRouteId) {
  if (!roadNetwork || !pathBySourceRoadNetworkRouteId.size) {
    return roadNetwork;
  }
  return {
    ...roadNetwork,
    streetRoutes: applySmoothedRoutePathsToStoredRoutes(roadNetwork.streetRoutes || [], pathBySourceRoadNetworkRouteId),
    virtualRoadRoutes: applySmoothedRoutePathsToStoredRoutes(roadNetwork.virtualRoadRoutes || [], pathBySourceRoadNetworkRouteId),
  };
}

function applySmoothedRoutePathsToStoredRoutes(storedRoutes, pathBySourceRoadNetworkRouteId) {
  return storedRoutes.flatMap((route) => {
    const path = pathBySourceRoadNetworkRouteId.get(route.id);
    if (!path || path.length < 2) {
      return [route];
    }
    const routeType = route.features?.routeType || route.type || "street";
    return path.slice(0, -1).map((from, index) => {
      const to = path[index + 1];
      return {
        ...route,
        id: `${route.id}:smooth:${index}`,
        from: clonePoint(from),
        to: clonePoint(to),
        length: pointDistance(from, to),
        midpoint: midpointBetween(from, to),
        fromNode: index === 0 ? route.fromNode : null,
        toNode: index === path.length - 2 ? route.toNode : null,
        features: {
          ...(route.features || {}),
          roadSmoothed: true,
          routeType,
        },
      };
    });
  });
}

function orientPathForRoute(path, route, nodes) {
  if (!route || path.length < 2) {
    return path;
  }
  const from = nodes.find((node) => node.id === route.fromNodeId);
  const to = nodes.find((node) => node.id === route.toNodeId);
  if (!from || !to) {
    return path;
  }
  const forwardDistance = pointDistance(path[0], from) + pointDistance(path[path.length - 1], to);
  const reverseDistance = pointDistance(path[path.length - 1], from) + pointDistance(path[0], to);
  return forwardDistance <= reverseDistance ? path : [...path].reverse();
}

function pushMapValue(map, key, value) {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
