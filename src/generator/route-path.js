/*
 * WHAT: Find UI/navigation paths over the canonical route graph.
 * HOW: Run Dijkstra over road routes and add a fixed cost for intermediate river crossings.
 * WHY: Step 2+ interactions need deterministic pathfinding without depending on DOM state.
 */

const CROSSING_NODE_TYPE = "river_crossing";
const DEFAULT_CROSSING_PENALTY = 1500;
const ROAD_ROUTE_WEIGHT_FACTOR = 3;
const ALLEY_ROUTE_WEIGHT_FACTOR = 6;
const TRAVERSABLE_ROUTE_TYPE = "road";
const CENTER_ROUTE_NODE_TYPE = "lot_center";
const INVALID_LAND_NODE_TYPES = new Set(["sea", "coast", "river_mouth", "river"]);

export function isRouteGraphJunctionNode(node) {
  return Boolean(node && (node.type === "river_crossing" || node.type === "river_mouth" || (node.routeIds || []).length > 2));
}

export function isLandRouteNode(routeGraph, nodeOrId) {
  const node = typeof nodeOrId === "object" ? nodeOrId : findRouteGraphNode(routeGraph, nodeOrId);
  if (!isRouteGraphJunctionNode(node) || INVALID_LAND_NODE_TYPES.has(node.type)) {
    return false;
  }

  const routesById = new Map((routeGraph?.routes || []).map((route) => [route.id, route]));
  return (node.routeIds || []).some((routeId) => routesById.get(routeId)?.type === TRAVERSABLE_ROUTE_TYPE);
}

export function isLotCenterRouteNode(routeGraph, nodeOrId) {
  const node = typeof nodeOrId === "object" ? nodeOrId : findRouteGraphNode(routeGraph, nodeOrId);
  if (!node || node.type !== CENTER_ROUTE_NODE_TYPE || node.lotId === null || node.lotId === undefined) {
    return false;
  }

  const routesById = new Map((routeGraph?.routes || []).map((route) => [route.id, route]));
  return (node.routeIds || []).some((routeId) => routesById.get(routeId)?.type === "alley");
}

export function findShortestLandRoutePath(routeGraph, startNodeId, targetNodeId, options = {}) {
  const crossingPenalty = options.crossingPenalty ?? DEFAULT_CROSSING_PENALTY;
  const routeTypes = options.routeTypes || [TRAVERSABLE_ROUTE_TYPE];
  const isValidNode = options.nodeValidator || isLandRouteNode;
  const startId = normalizeNodeId(startNodeId);
  const targetId = normalizeNodeId(targetNodeId);
  if (startId === null || targetId === null || !routeGraph) {
    return null;
  }

  const nodesById = new Map((routeGraph.nodes || []).map((node) => [node.id, node]));
  if (!isValidNode(routeGraph, startId) || !isValidNode(routeGraph, targetId)) {
    return null;
  }
  if (startId === targetId) {
    const node = nodesById.get(startId);
    return node ? { nodeIds: [startId], routeIds: [], distance: 0, actualLength: 0, crossingCost: 0, points: [node] } : null;
  }

  const routesById = new Map((routeGraph.routes || []).map((route) => [route.id, route]));
  const adjacency = buildRouteAdjacency(routeGraph, routeTypes);
  const distances = new Map([[startId, 0]]);
  const previous = new Map();
  const queue = new MinPriorityQueue();
  queue.push(startId, 0);

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current || current.priority > (distances.get(current.nodeId) ?? Infinity)) {
      continue;
    }
    if (current.nodeId === targetId) {
      break;
    }

    (adjacency.get(current.nodeId) || []).forEach((edge) => {
      const nextNode = nodesById.get(edge.toNodeId);
      if (!nextNode) {
        return;
      }
      const nodePenalty = edge.routeType === TRAVERSABLE_ROUTE_TYPE
        && nextNode.type === CROSSING_NODE_TYPE
        && edge.toNodeId !== targetId
        && edge.toNodeId !== startId
        ? crossingPenalty
        : 0;
      const nextDistance = current.priority + edge.weight + nodePenalty;
      if (nextDistance >= (distances.get(edge.toNodeId) ?? Infinity)) {
        return;
      }

      distances.set(edge.toNodeId, nextDistance);
      previous.set(edge.toNodeId, {
        nodeId: current.nodeId,
        routeId: edge.routeId,
      });
      queue.push(edge.toNodeId, nextDistance);
    });
  }

  if (!previous.has(targetId)) {
    return null;
  }

  const nodeIds = [targetId];
  const routeIds = [];
  for (let currentId = targetId; currentId !== startId;) {
    const step = previous.get(currentId);
    if (!step) {
      return null;
    }
    routeIds.push(step.routeId);
    nodeIds.push(step.nodeId);
    currentId = step.nodeId;
  }
  nodeIds.reverse();
  routeIds.reverse();

  const distance = distances.get(targetId) ?? Infinity;
  const actualLength = routeIds.reduce((sum, routeId) => sum + (routesById.get(routeId)?.length || 0), 0);
  return {
    nodeIds,
    routeIds,
    distance,
    actualLength,
    crossingCost: distance - actualLength,
    points: nodeIds.map((nodeId) => nodesById.get(nodeId)).filter(Boolean),
  };
}

export function getRouteWeightedLength(route) {
  if (route?.type === TRAVERSABLE_ROUTE_TYPE) {
    return (route.length || 0) * ROAD_ROUTE_WEIGHT_FACTOR;
  }
  if (route?.type === "alley") {
    return (route.length || 0) * ALLEY_ROUTE_WEIGHT_FACTOR;
  }
  return route?.length || 0;
}

export function getDefaultRouteCrossingPenalty() {
  return DEFAULT_CROSSING_PENALTY;
}

export function findRouteGraphNode(routeGraph, nodeId) {
  const normalizedId = normalizeNodeId(nodeId);
  if (normalizedId === null) {
    return null;
  }
  return (routeGraph?.nodes || []).find((node) => node.id === normalizedId) || null;
}

function buildRouteAdjacency(routeGraph, routeTypes) {
  const traversableTypes = new Set(routeTypes);
  const adjacency = new Map();
  (routeGraph.routes || []).forEach((route) => {
    if (!traversableTypes.has(route.type)) {
      return;
    }
    appendAdjacency(adjacency, route.fromNodeId, {
      toNodeId: route.toNodeId,
      routeId: route.id,
      routeType: route.type,
      length: route.length,
      weight: getRouteWeightedLength(route),
    });
    appendAdjacency(adjacency, route.toNodeId, {
      toNodeId: route.fromNodeId,
      routeId: route.id,
      routeType: route.type,
      length: route.length,
      weight: getRouteWeightedLength(route),
    });
  });
  return adjacency;
}

function appendAdjacency(adjacency, nodeId, edge) {
  const edges = adjacency.get(nodeId) || [];
  edges.push(edge);
  adjacency.set(nodeId, edges);
}

function normalizeNodeId(nodeId) {
  const normalizedId = Number(nodeId);
  return Number.isInteger(normalizedId) ? normalizedId : null;
}

class MinPriorityQueue {
  constructor() {
    this.heap = [];
  }

  push(nodeId, priority) {
    this.heap.push({ nodeId, priority });
    this.bubbleUp();
  }

  pop() {
    if (this.heap.length === 0) {
      return null;
    }
    if (this.heap.length === 1) {
      return this.heap.pop();
    }

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
      if (this.heap[parentIndex].priority <= this.heap[index].priority) {
        break;
      }
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
      if (smallestIndex === index) {
        break;
      }

      [this.heap[smallestIndex], this.heap[index]] = [this.heap[index], this.heap[smallestIndex]];
      index = smallestIndex;
    }
  }
}
