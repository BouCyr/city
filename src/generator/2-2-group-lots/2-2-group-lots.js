/*
 * WHAT: Group land lots into parish clusters using route-graph distances.
 * HOW: Pick graph-spread seeds, then grow parishes by weighted road-route distance from step 2.1.
 * WHY: Parishes provide a higher-level organizational structure for the city.
 */

import { pointDistance } from "../map-model.js";
import { getDefaultRouteCrossingPenalty, getRouteWeightedLength } from "../route-path.js";

export function runGroupLotsStep(map) {
  const lots = map.lots || [];
  const landLots = lots.filter(lot => lot.features?.land && !lot.features?.sea);

  if (landLots.length === 0) {
    return {
      map,
      frameEntries: [{ label: "Step 2.2 / Parish clustering", map }]
    };
  }

  const k = Math.min(landLots.length, map.init?.params?.parishCount || 10);
  const clusters = runRouteGraphClustering(map, landLots, k);

  const nextLots = lots.map(lot => {
    const clusterIndex = clusters.findIndex(c => c.includes(lot.id));
    return {
      ...lot,
      parishId: clusterIndex !== -1 ? clusterIndex : null
    };
  });

  const parishColors = assignParishColors(nextLots, k);

  const nextMap = {
    ...map,
    lots: nextLots,
    parishColors
  };

  return {
    map: nextMap,
    frameEntries: [{ label: "Step 2.2 / Parish clustering", map: nextMap }]
  };
}

function runRouteGraphClustering(map, landLots, k) {
  const n = landLots.length;
  const adj = buildLotGraph(map, landLots);
  const kFinal = Math.min(k, n);

  // Identify the most centered land lot to anchor the main landmass.
  const mapSize = map.meta?.size || 1000;
  const center = { x: mapSize / 2, y: mapSize / 2 };
  let bestIdx = 0;
  let minDistToCenter = Infinity;
  landLots.forEach((lot, i) => {
    const d = pointDistance(lot.centroid, center);
    if (d < minDistToCenter) {
      minDistToCenter = d;
      bestIdx = i;
    }
  });

  const seedIndices = chooseRouteGraphSeeds(adj, bestIdx, kFinal);
  const assignments = assignLotsFromSeeds(adj, seedIndices);
  const clusters = Array.from({ length: k }, () => []);
  for (let index = 0; index < n; index += 1) {
    if (assignments[index] >= 0) {
      clusters[assignments[index]].push(landLots[index].id);
    }
  }

  const islandIndices = [];
  for (let index = 0; index < n; index += 1) {
    if (assignments[index] < 0) {
      islandIndices.push(index);
    }
  }
  if (islandIndices.length > 0) {
    const parishCentroids = clusters.map((ids) => {
      if (ids.length === 0) return null;
      let x = 0, y = 0;
      ids.forEach(id => {
        const lot = landLots.find(l => l.id === id);
        x += lot.centroid.x;
        y += lot.centroid.y;
      });
      return { x: x / ids.length, y: y / ids.length };
    });

    islandIndices.forEach(idx => {
      const lot = landLots[idx];
      let minDist = Infinity;
      let bestParish = 0;
      parishCentroids.forEach((centroid, parishIdx) => {
        if (!centroid) return;
        const d = pointDistance(lot.centroid, centroid);
        if (d < minDist) {
          minDist = d;
          bestParish = parishIdx;
        }
      });
      clusters[bestParish].push(lot.id);
    });
  }

  return clusters;
}

function chooseRouteGraphSeeds(adj, firstSeed, k) {
  const seeds = [firstSeed];
  let bestDistances = computeSingleSourceDistances(adj, firstSeed);

  while (seeds.length < k) {
    let nextSeed = -1;
    let nextDistance = -Infinity;
    for (let index = 0; index < bestDistances.length; index += 1) {
      if (seeds.includes(index) || !Number.isFinite(bestDistances[index])) {
        continue;
      }
      if (bestDistances[index] > nextDistance) {
        nextDistance = bestDistances[index];
        nextSeed = index;
      }
    }
    if (nextSeed < 0) {
      break;
    }

    seeds.push(nextSeed);
    const distances = computeSingleSourceDistances(adj, nextSeed);
    for (let index = 0; index < bestDistances.length; index += 1) {
      bestDistances[index] = Math.min(bestDistances[index], distances[index]);
    }
  }

  return seeds;
}

function assignLotsFromSeeds(adj, seeds) {
  const assignments = new Int32Array(adj.length).fill(-1);
  const distances = new Float32Array(adj.length).fill(Infinity);
  const visited = new Uint8Array(adj.length);

  seeds.forEach((seed, parishIndex) => {
    assignments[seed] = parishIndex;
    distances[seed] = 0;
  });

  while (true) {
    const node = findNearestUnvisited(distances, visited);
    if (node < 0) break;

    visited[node] = 1;
    for (const edge of adj[node]) {
      const newDist = distances[node] + edge.weight;
      if (newDist < distances[edge.to]) {
        distances[edge.to] = newDist;
        assignments[edge.to] = assignments[node];
      }
    }
  }

  return assignments;
}

function buildLotGraph(map, landLots) {
  const lotIdToIndex = new Map(landLots.map((lot, i) => [lot.id, i]));
  const n = landLots.length;
  const adj = Array.from({ length: n }, () => []);
  const routeGraph = map.routeGraph || null;
  const routeGraphRoutes = routeGraph?.routes || [];
  const graphRoutes = routeGraphRoutes.length ? routeGraphRoutes : map.segments || [];
  const nodesById = new Map((routeGraph?.nodes || []).map((node) => [node.id, node]));
  const crossingPenalty = map.init?.params?.routeCrossingCost ?? getDefaultRouteCrossingPenalty();

  graphRoutes.forEach(route => {
    if (route.type && route.type !== "road") {
      return;
    }

    const l1 = route.leftLotId;
    const r1 = route.rightLotId;
    if (lotIdToIndex.has(l1) && lotIdToIndex.has(r1)) {
      const i = lotIdToIndex.get(l1);
      const j = lotIdToIndex.get(r1);
      const crossingCount = [nodesById.get(route.fromNodeId), nodesById.get(route.toNodeId)]
        .filter((node) => node?.type === "river_crossing")
        .length;
      const weight = getRouteWeightedLength(route) + (crossingPenalty * crossingCount);

      adj[i].push({ to: j, weight });
      adj[j].push({ to: i, weight });
    }
  });
  return adj;
}

function computeSingleSourceDistances(adj, start) {
  const distances = new Float32Array(adj.length).fill(Infinity);
  const visited = new Uint8Array(adj.length);
  distances[start] = 0;

  while (true) {
    const node = findNearestUnvisited(distances, visited);
    if (node < 0) break;

    visited[node] = 1;
    for (const edge of adj[node]) {
      const newDist = distances[node] + edge.weight;
      if (newDist < distances[edge.to]) {
        distances[edge.to] = newDist;
      }
    }
  }

  return distances;
}

function findNearestUnvisited(distances, visited) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < distances.length; index += 1) {
    if (visited[index] || distances[index] >= bestDistance) {
      continue;
    }
    bestIndex = index;
    bestDistance = distances[index];
  }
  return Number.isFinite(bestDistance) ? bestIndex : -1;
}

function assignParishColors(lots, k) {
  // Build parish adjacency graph
  const adj = Array.from({ length: k }, () => new Set());
  const lotById = new Map(lots.map(l => [l.id, l]));

  lots.forEach(lot => {
    if (lot.parishId === null) return;
    (lot.neighborLotIds || []).forEach(neighborId => {
      const neighbor = lotById.get(neighborId);
      if (neighbor && neighbor.parishId !== null && neighbor.parishId !== lot.parishId) {
        adj[lot.parishId].add(neighbor.parishId);
        adj[neighbor.parishId].add(lot.parishId);
      }
    });
  });

  // Greedily color the graph
  const colors = new Int32Array(k).fill(-1);
  for (let i = 0; i < k; i++) {
    const usedColors = new Set();
    adj[i].forEach(neighbor => {
      if (colors[neighbor] !== -1) usedColors.add(colors[neighbor]);
    });
    let color = 0;
    while (usedColors.has(color)) color++;
    colors[i] = color;
  }

  // Map each parish to a unique color using the golden angle for hue distribution.
  // Rescale the hue to avoid the yellow/brown range (35° to 95°).
  return Array.from({ length: k }, (_, i) => {
    // Golden angle distribution over 300 degrees instead of 360
    const rawHue = (i * 137.5) % 300;
    // Map [0, 300] to [95, 395] (which is [95, 360] + [0, 35])
    const hue = (rawHue + 95) % 360;

    const saturation = 50 + (i % 3) * 15; // 50%, 65%, 80%
    const lightness = 65 + (i % 2) * 15; // 65%, 80%
    return {
      fill: `hsla(${hue}, ${saturation}%, ${lightness}%, 0.5)`,
      border: `hsla(${hue}, ${saturation + 10}%, ${lightness - 30}%, 0.4)`
    };
  });
}
