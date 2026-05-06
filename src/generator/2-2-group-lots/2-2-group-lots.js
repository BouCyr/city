/*
 * WHAT: Group land lots into parish clusters using center-node route distances.
 * HOW: Add lot-center alleys, then run the selected graph clustering algorithm over weighted routes.
 * WHY: Parish distance should reflect travel from lot centers rather than shared-boundary shortcuts.
 */

import { pointDistance } from "../map-model.js";
import { addLotCenterAlleyRoutesToRouteGraph } from "../route-graph.js";
import { getDefaultRouteCrossingPenalty, getRouteWeightedLength } from "../route-path.js";

const DEFAULT_PARISH_ALGORITHM = "graph_kmeans";
const MAX_KMEANS_ITERATIONS = 20;
const TRAVERSABLE_ROUTE_TYPES = new Set(["road", "alley"]);
const DISTANCE_EPSILON = 0.0000001;
const PARISH_NAMES = [
  "Santo Adriano",
  "Santa Alessia",
  "Santo Alonso",
  "Santa Amalia",
  "Santo Antonio",
  "Santa Beatriz",
  "Santo Benedetto",
  "Santa Bianca",
  "Santo Bruno",
  "Santa Camila",
  "Santo Carlo",
  "Santa Carmela",
  "Santo Cesare",
  "Santa Catalina",
  "Santo Diego",
  "Santa Chiara",
  "Santo Domenico",
  "Santa Elena",
  "Santo Emilio",
  "Santa Esmeralda",
  "Santo Enrico",
  "Santa Fabiana",
  "Santo Esteban",
  "Santa Federica",
  "Santo Fabio",
  "Santa Gianna",
  "Santo Felipe",
  "Santa Graciela",
  "Santo Francesco",
  "Santa Ines",
  "Santo Gabriel",
  "Santa Isabella",
  "Santo Giacomo",
  "Santa Josefina",
  "Santo Ignacio",
  "Santa Lucia",
  "Santo Javier",
  "Santa Marcella",
  "Santo Lorenzo",
  "Santa Marisol",
  "Santo Luciano",
  "Santa Natalia",
  "Santo Marco",
  "Santa Paloma",
  "Santo Mateo",
  "Santa Rafaela",
  "Santo Paolo",
  "Santa Rosalia",
  "Santo Rafael",
  "Santa Valentina",
];

export function runGroupLotsStep(map) {
  const lots = map.lots || [];
  const landLots = lots.filter((lot) => lot.features?.land && !lot.features?.sea);

  if (landLots.length === 0) {
    return {
      map,
      frameEntries: [{ label: "Step 2.2 / Parish clustering", map }]
    };
  }

  const routeGraph = addLotCenterAlleyRoutesToRouteGraph(map);
  const workingMap = { ...map, routeGraph };
  const k = Math.min(landLots.length, map.init?.params?.parishCount || 15);
  const graph = buildCenterRouteGraph(workingMap, landLots);
  const algorithm = normalizeParishAlgorithm(map.init?.params?.stepAlgorithms?.parishClustering);
  const result = runSelectedClustering(graph, algorithm, k);
  const clusterByLotId = buildClusterByLotId(graph, result.assignments);

  const nextLots = lots.map((lot) => {
    const parishId = clusterByLotId.get(lot.id);
    const letter = parishId === undefined ? null : parishLetter(parishId);
    const parishName = parishId === undefined ? null : parishNameForId(parishId);
    return {
      ...lot,
      parishId: parishId ?? null,
      parishLetter: letter,
      parishName,
      parish: parishName,
    };
  });

  const parishColors = assignParishColors(nextLots, k);
  const parishCenters = computeParishCenters(graph, nextLots, result.centerNodeIds, parishColors);

  const nextMap = {
    ...workingMap,
    lots: nextLots,
    parishColors,
    parishCenters,
  };

  return {
    map: nextMap,
    frameEntries: [{ label: "Step 2.2 / Parish clustering", map: nextMap }]
  };
}

function runSelectedClustering(graph, algorithm, k) {
  if (algorithm === "route_growth") {
    return runRouteGrowthClustering(graph, k);
  }
  if (algorithm === "graph_kmedoids") {
    return runGraphKmedoids(graph, k);
  }
  return runGraphKmeans(graph, k);
}

function runGraphKmeans(graph, k) {
  let centerNodeIds = chooseInitialCenterNodeIds(graph, k);
  let assignments = new Int32Array(graph.lotEntries.length).fill(-1);

  for (let iteration = 0; iteration < MAX_KMEANS_ITERATIONS; iteration += 1) {
    assignments = assignLotsToCenterNodes(graph, centerNodeIds);
    const nextCenterNodeIds = repairCenterNodeIds(graph, centerNodeIds.map((centerNodeId, parishId) => {
      const assignedLots = graph.lotEntries.filter((entry, index) => assignments[index] === parishId);
      if (!assignedLots.length) {
        return null;
      }
      const average = averageLotCentroid(assignedLots);
      return findNearestLotCenterNodeId(graph, average);
    }), assignments);

    if (sameNodeIds(centerNodeIds, nextCenterNodeIds)) {
      break;
    }
    centerNodeIds = nextCenterNodeIds;
  }

  assignments = assignLotsToCenterNodes(graph, centerNodeIds);
  return { assignments, centerNodeIds };
}

function runGraphKmedoids(graph, k) {
  let centerNodeIds = chooseInitialCenterNodeIds(graph, k);
  let assignments = new Int32Array(graph.lotEntries.length).fill(-1);

  for (let iteration = 0; iteration < MAX_KMEANS_ITERATIONS; iteration += 1) {
    assignments = assignLotsToCenterNodes(graph, centerNodeIds);
    const nextCenterNodeIds = repairCenterNodeIds(graph, centerNodeIds.map((centerNodeId, parishId) => {
      const assignedIndices = graph.lotEntries
        .map((entry, index) => assignments[index] === parishId ? index : -1)
        .filter((index) => index >= 0);
      if (!assignedIndices.length) {
        return null;
      }
      return chooseMedoidNodeId(graph, assignedIndices);
    }), assignments);

    if (sameNodeIds(centerNodeIds, nextCenterNodeIds)) {
      break;
    }
    centerNodeIds = nextCenterNodeIds;
  }

  assignments = assignLotsToCenterNodes(graph, centerNodeIds);
  return { assignments, centerNodeIds };
}

function runRouteGrowthClustering(graph, k) {
  const centerNodeIds = chooseInitialCenterNodeIds(graph, k);
  return {
    centerNodeIds,
    assignments: assignLotsToCenterNodes(graph, centerNodeIds),
  };
}

function chooseInitialCenterNodeIds(graph, k) {
  const firstNodeId = findNearestLotCenterNodeId(graph, {
    x: (graph.mapSize || 1000) / 2,
    y: (graph.mapSize || 1000) / 2,
  });
  const seeds = [firstNodeId];
  const seedSet = new Set(seeds);
  let bestDistances = getSingleSourceDistances(graph, firstNodeId);

  while (seeds.length < k) {
    let nextNodeId = null;
    let nextDistance = -Infinity;
    graph.lotEntries.forEach((entry) => {
      if (seedSet.has(entry.nodeId)) {
        return;
      }
      const distance = bestDistances.get(entry.nodeId) ?? Infinity;
      if (!Number.isFinite(distance)) {
        return;
      }
      if (distance > nextDistance) {
        nextDistance = distance;
        nextNodeId = entry.nodeId;
      }
    });
    if (nextNodeId === null) {
      break;
    }

    seeds.push(nextNodeId);
    seedSet.add(nextNodeId);
    const distances = getSingleSourceDistances(graph, nextNodeId);
    graph.lotEntries.forEach((entry) => {
      bestDistances.set(entry.nodeId, Math.min(bestDistances.get(entry.nodeId) ?? Infinity, distances.get(entry.nodeId) ?? Infinity));
    });
  }

  return repairCenterNodeIds(graph, seeds, new Int32Array(graph.lotEntries.length).fill(-1)).slice(0, k);
}

function assignLotsToCenterNodes(graph, centerNodeIds) {
  const owners = computeNearestCenterOwners(graph, centerNodeIds);
  const assignments = new Int32Array(graph.lotEntries.length).fill(-1);

  graph.lotEntries.forEach((entry, index) => {
    let bestParish = owners.get(entry.nodeId) ?? -1;
    if (bestParish < 0) {
      bestParish = findNearestEuclideanCenterIndex(graph, entry, centerNodeIds);
    }
    assignments[index] = bestParish;
  });

  return assignments;
}

function findNearestEuclideanCenterIndex(graph, entry, centerNodeIds) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  centerNodeIds.forEach((nodeId, index) => {
    const node = graph.nodesById.get(nodeId);
    if (!node) {
      return;
    }
    const distance = pointDistance(entry.lot.centroid, node);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function repairCenterNodeIds(graph, proposedNodeIds, assignments) {
  const repaired = [];
  proposedNodeIds.forEach((nodeId) => {
    if (nodeId !== null && nodeId !== undefined && !repaired.includes(nodeId)) {
      repaired.push(nodeId);
    }
  });

  while (repaired.length < graph.k) {
    const replacement = findFarthestUnchosenCenterNodeId(graph, repaired, assignments);
    if (replacement === null) {
      break;
    }
    repaired.push(replacement);
  }

  return repaired;
}

function findFarthestUnchosenCenterNodeId(graph, chosenNodeIds, assignments) {
  let bestNodeId = null;
  let bestDistance = -Infinity;
  const chosenNodeIdSet = new Set(chosenNodeIds);
  const chosenDistances = chosenNodeIds.map((nodeId) => getSingleSourceDistances(graph, nodeId));

  graph.lotEntries.forEach((entry, index) => {
    if (chosenNodeIdSet.has(entry.nodeId)) {
      return;
    }
    const isEmptyRepair = assignments[index] < 0;
    const distance = chosenDistances.length
      ? Math.min(...chosenDistances.map((distances) => distances.get(entry.nodeId) ?? Infinity))
      : Infinity;
    const score = isEmptyRepair ? Infinity : distance;
    if (score > bestDistance) {
      bestDistance = score;
      bestNodeId = entry.nodeId;
    }
  });

  return bestNodeId;
}

function chooseMedoidNodeId(graph, lotIndices) {
  let bestNodeId = graph.lotEntries[lotIndices[0]].nodeId;
  let bestDistance = Infinity;

  lotIndices.forEach((candidateIndex) => {
    const candidate = graph.lotEntries[candidateIndex];
    const totalDistance = lotIndices.reduce((sum, lotIndex) =>
      sum + getLotCenterDistance(graph, candidate, graph.lotEntries[lotIndex]), 0);
    if (totalDistance < bestDistance) {
      bestDistance = totalDistance;
      bestNodeId = candidate.nodeId;
    }
  });

  return bestNodeId;
}

function computeNearestCenterOwners(graph, centerNodeIds) {
  const distances = new Map();
  const owners = new Map();
  const queue = new MinPriorityQueue();

  centerNodeIds.forEach((nodeId, parishId) => {
    distances.set(nodeId, 0);
    owners.set(nodeId, parishId);
    queue.push({ nodeId, parishId, priority: 0 });
  });

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current) {
      break;
    }

    const knownDistance = distances.get(current.nodeId) ?? Infinity;
    const knownOwner = owners.get(current.nodeId) ?? Infinity;
    if (current.priority > knownDistance + DISTANCE_EPSILON || current.parishId !== knownOwner) {
      continue;
    }

    (graph.adjacency.get(current.nodeId) || []).forEach((edge) => {
      const nextDistance = current.priority + edge.weight;
      const previousDistance = distances.get(edge.toNodeId) ?? Infinity;
      const previousOwner = owners.get(edge.toNodeId) ?? Infinity;
      if (
        nextDistance + DISTANCE_EPSILON < previousDistance
        || (Math.abs(nextDistance - previousDistance) <= DISTANCE_EPSILON && current.parishId < previousOwner)
      ) {
        distances.set(edge.toNodeId, nextDistance);
        owners.set(edge.toNodeId, current.parishId);
        queue.push({ nodeId: edge.toNodeId, parishId: current.parishId, priority: nextDistance });
      }
    });
  }

  return owners;
}

function getSingleSourceDistances(graph, startNodeId) {
  const cached = graph.distanceCache.get(startNodeId);
  if (cached) {
    return cached;
  }

  const distances = computeSingleSourceDistances(graph, startNodeId);
  graph.distanceCache.set(startNodeId, distances);
  return distances;
}

function computeSingleSourceDistances(graph, startNodeId) {
  const distances = new Map([[startNodeId, 0]]);
  const queue = new MinPriorityQueue();
  queue.push({ nodeId: startNodeId, parishId: 0, priority: 0 });

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current) {
      break;
    }
    if (current.priority > (distances.get(current.nodeId) ?? Infinity) + DISTANCE_EPSILON) {
      continue;
    }

    (graph.adjacency.get(current.nodeId) || []).forEach((edge) => {
      const nextDistance = current.priority + edge.weight;
      if (nextDistance + DISTANCE_EPSILON < (distances.get(edge.toNodeId) ?? Infinity)) {
        distances.set(edge.toNodeId, nextDistance);
        queue.push({ nodeId: edge.toNodeId, parishId: 0, priority: nextDistance });
      }
    });
  }

  return distances;
}

function getLotCenterDistance(graph, fromEntry, toEntry) {
  const distance = getSingleSourceDistances(graph, fromEntry.nodeId).get(toEntry.nodeId) ?? Infinity;
  return Number.isFinite(distance) ? distance : pointDistance(fromEntry.lot.centroid, toEntry.lot.centroid);
}

function buildCenterRouteGraph(map, landLots) {
  const routeGraph = map.routeGraph || { nodes: [], routes: [] };
  const nodesById = new Map(routeGraph.nodes.map((node) => [node.id, node]));
  const lotById = new Map(landLots.map((lot) => [lot.id, lot]));
  const lotEntries = routeGraph.nodes
    .filter((node) => node.type === "lot_center" && lotById.has(node.lotId))
    .map((node) => ({
      lot: lotById.get(node.lotId),
      lotId: node.lotId,
      nodeId: node.id,
    }))
    .sort((first, second) => first.lotId - second.lotId);
  const crossingPenalty = map.init?.params?.routeCrossingCost ?? getDefaultRouteCrossingPenalty();
  const adjacency = new Map();

  routeGraph.routes.forEach((route) => {
    if (!TRAVERSABLE_ROUTE_TYPES.has(route.type)) {
      return;
    }
    appendRouteEdge(adjacency, nodesById, route, route.fromNodeId, route.toNodeId, crossingPenalty);
    appendRouteEdge(adjacency, nodesById, route, route.toNodeId, route.fromNodeId, crossingPenalty);
  });

  return {
    adjacency,
    k: Math.min(lotEntries.length, map.init?.params?.parishCount || 15),
    lotEntries,
    mapSize: map.meta?.size || 1000,
    nodesById,
    distanceCache: new Map(),
  };
}

function appendRouteEdge(adjacency, nodesById, route, fromNodeId, toNodeId, crossingPenalty) {
  const toNode = nodesById.get(toNodeId);
  const crossingCost = route.type === "road" && toNode?.type === "river_crossing" ? crossingPenalty : 0;
  const edges = adjacency.get(fromNodeId) || [];
  edges.push({
    toNodeId,
    routeId: route.id,
    weight: getRouteWeightedLength(route) + crossingCost,
  });
  adjacency.set(fromNodeId, edges);
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
      if (queueItemLessOrEqual(this.heap[parentIndex], this.heap[index])) {
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

      if (leftIndex < this.heap.length && queueItemLess(this.heap[leftIndex], this.heap[smallestIndex])) {
        smallestIndex = leftIndex;
      }
      if (rightIndex < this.heap.length && queueItemLess(this.heap[rightIndex], this.heap[smallestIndex])) {
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

function queueItemLess(first, second) {
  if (Math.abs(first.priority - second.priority) > DISTANCE_EPSILON) {
    return first.priority < second.priority;
  }
  if ((first.parishId ?? 0) !== (second.parishId ?? 0)) {
    return (first.parishId ?? 0) < (second.parishId ?? 0);
  }
  return first.nodeId < second.nodeId;
}

function queueItemLessOrEqual(first, second) {
  return !queueItemLess(second, first);
}

function buildClusterByLotId(graph, assignments) {
  const clusterByLotId = new Map();
  graph.lotEntries.forEach((entry, index) => {
    if (assignments[index] >= 0) {
      clusterByLotId.set(entry.lotId, assignments[index]);
    }
  });
  return clusterByLotId;
}

function computeParishCenters(graph, lots, centerNodeIds, parishColors) {
  const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
  return centerNodeIds
    .map((nodeId, parishId) => {
      const node = graph.nodesById.get(nodeId);
      const lot = lotsById.get(node?.lotId);
      if (!node || !lot) {
        return null;
      }
      const parishLots = lots.filter((item) => item.parishId === parishId);
      return {
        parishId,
        letter: parishLetter(parishId),
        name: parishNameForId(parishId),
        lotId: lot.id,
        nodeId: node.id,
        centroid: averageLotCentroid(parishLots.length ? parishLots.map((item) => ({ lot: item })) : [{ lot }]),
        x: node.x,
        y: node.y,
        color: parishColors[parishId]?.border || parishColors[parishId]?.fill || null,
      };
    })
    .filter(Boolean);
}

function findNearestLotCenterNodeId(graph, point) {
  let bestNodeId = graph.lotEntries[0]?.nodeId ?? null;
  let bestDistance = Infinity;
  graph.lotEntries.forEach((entry) => {
    const distance = pointDistance(entry.lot.centroid, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNodeId = entry.nodeId;
    }
  });
  return bestNodeId;
}

function averageLotCentroid(entries) {
  return {
    x: entries.reduce((sum, entry) => sum + entry.lot.centroid.x, 0) / entries.length,
    y: entries.reduce((sum, entry) => sum + entry.lot.centroid.y, 0) / entries.length,
  };
}

function sameNodeIds(first, second) {
  return first.length === second.length && first.every((nodeId, index) => nodeId === second[index]);
}

function normalizeParishAlgorithm(value) {
  return value === "route_growth" || value === "graph_kmedoids" ? value : DEFAULT_PARISH_ALGORITHM;
}

function parishLetter(parishId) {
  return String.fromCharCode(65 + (parishId % 26));
}

function parishNameForId(parishId) {
  return PARISH_NAMES[parishId % PARISH_NAMES.length];
}

function assignParishColors(lots, k) {
  const adj = Array.from({ length: k }, () => new Set());
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));

  lots.forEach((lot) => {
    if (lot.parishId === null) return;
    (lot.neighborLotIds || []).forEach((neighborId) => {
      const neighbor = lotById.get(neighborId);
      if (neighbor && neighbor.parishId !== null && neighbor.parishId !== lot.parishId) {
        adj[lot.parishId].add(neighbor.parishId);
        adj[neighbor.parishId].add(lot.parishId);
      }
    });
  });

  const colors = new Int32Array(k).fill(-1);
  for (let i = 0; i < k; i += 1) {
    const usedColors = new Set();
    adj[i].forEach((neighbor) => {
      if (colors[neighbor] !== -1) usedColors.add(colors[neighbor]);
    });
    let color = 0;
    while (usedColors.has(color)) color += 1;
    colors[i] = color;
  }

  return Array.from({ length: k }, (_, i) => {
    const rawHue = (i * 137.5) % 300;
    const hue = (rawHue + 95) % 360;
    const saturation = 50 + (i % 3) * 15;
    const lightness = 65 + (i % 2) * 15;
    return {
      fill: `hsla(${hue}, ${saturation}%, ${lightness}%, 0.5)`,
      border: `hsla(${hue}, ${saturation + 10}%, ${lightness - 30}%, 0.4)`
    };
  });
}
