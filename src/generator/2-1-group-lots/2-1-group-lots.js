/*
 * WHAT: Group land lots into 'parish' clusters using k-means/k-medoids.
 * HOW: Use the selected distance algorithm (Euclidean or graph-based with river penalty)
 *      to cluster land lots into K groups.
 * WHY: Parishes provide a higher-level organizational structure for the city.
 */

import { pointDistance } from "../map-model.js";

export function runGroupLotsStep(map, { rng }) {
  const lots = map.lots || [];
  const landLots = lots.filter(lot => lot.features?.land && !lot.features?.sea);

  if (landLots.length === 0) {
    return {
      map,
      frameEntries: [{ label: "Step 2.1 / Parish clustering", map }]
    };
  }

  const k = Math.min(landLots.length, map.init?.params?.parishCount || 10);
  const algorithm = map.init?.params?.stepAlgorithms?.parishClustering || "euclidean_centroids";

  let clusters;
  if (algorithm === "euclidean_centroids") {
    clusters = runKMeansEuclidean(landLots, k, rng);
  } else {
    clusters = runKMedoidsGraph(map, landLots, k, rng, algorithm);
  }

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
    frameEntries: [{ label: "Step 2.1 / Parish clustering", map: nextMap }]
  };
}

function runKMeansEuclidean(lots, k, rng) {
  const initialIndices = sampleIndices(lots.length, k, rng);
  let centroids = initialIndices.map(i => ({ ...lots[i].centroid }));

  let assignments = new Map(); // lotId -> clusterIndex
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 50) {
    changed = false;
    iterations++;

    lots.forEach(lot => {
      let minDist = Infinity;
      let bestCluster = 0;
      centroids.forEach((c, i) => {
        const d = pointDistance(lot.centroid, c);
        if (d < minDist) {
          minDist = d;
          bestCluster = i;
        }
      });
      if (assignments.get(lot.id) !== bestCluster) {
        assignments.set(lot.id, bestCluster);
        changed = true;
      }
    });

    const newCentroids = Array.from({ length: k }, () => ({ x: 0, y: 0, count: 0 }));
    lots.forEach(lot => {
      const cluster = assignments.get(lot.id);
      newCentroids[cluster].x += lot.centroid.x;
      newCentroids[cluster].y += lot.centroid.y;
      newCentroids[cluster].count++;
    });

    centroids = newCentroids.map((c, i) => {
      if (c.count > 0) {
        return { x: c.x / c.count, y: c.y / c.count };
      }
      return centroids[i]; // Keep old centroid if cluster is empty
    });
  }

  const clusters = Array.from({ length: k }, () => []);
  lots.forEach(lot => {
    const cluster = assignments.get(lot.id);
    if (cluster !== undefined) {
      clusters[cluster].push(lot.id);
    }
  });
  return clusters;
}

function runKMedoidsGraph(map, landLots, k, rng, algorithm) {
  const n = landLots.length;
  const adj = buildLotGraph(map, landLots, algorithm);

  // Identify the "most centered" land lot to find the main landmass
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

  // BFS to find all reachable lots from the most centered one (main landmass)
  const reachable = new Set();
  const queue = [bestIdx];
  reachable.add(bestIdx);
  while (queue.length > 0) {
    const u = queue.shift();
    adj[u].forEach(edge => {
      if (!reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    });
  }

  const mainLandIndices = Array.from(reachable);
  const islandIndices = [];
  for (let i = 0; i < n; i++) {
    if (!reachable.has(i)) islandIndices.push(i);
  }

  // Only cluster lots on the main landmass
  const nMain = mainLandIndices.length;
  const mainAdj = mainLandIndices.map(i => {
    return adj[i].filter(e => reachable.has(e.to)).map(e => {
      return { to: mainLandIndices.indexOf(e.to), weight: e.weight };
    });
  });

  const dists = computeAllPairsDistances(nMain, mainAdj);

  const kFinal = Math.min(k, nMain);
  let medoids = sampleIndices(nMain, kFinal, rng);
  let assignments = new Int32Array(nMain).fill(-1);
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 20) {
    changed = false;
    iterations++;

    // Assignment
    for (let i = 0; i < nMain; i++) {
      let minDist = Infinity;
      let bestMedoid = 0;
      for (let m = 0; m < kFinal; m++) {
        const d = dists[i][medoids[m]];
        if (d < minDist) {
          minDist = d;
          bestMedoid = m;
        }
      }
      if (assignments[i] !== bestMedoid) {
        assignments[i] = bestMedoid;
        changed = true;
      }
    }

    // Update medoids
    const newMedoids = [...medoids];
    for (let m = 0; m < kFinal; m++) {
      const clusterIndices = [];
      for (let i = 0; i < nMain; i++) {
        if (assignments[i] === m) clusterIndices.push(i);
      }
      if (clusterIndices.length === 0) continue;

      let minTotalDist = Infinity;
      let bestMedoidIdx = newMedoids[m];
      for (const i of clusterIndices) {
        let totalDist = 0;
        for (const j of clusterIndices) {
          const d = dists[i][j];
          totalDist += (d === Infinity ? 1000000 : d);
        }
        if (totalDist < minTotalDist) {
          minTotalDist = totalDist;
          bestMedoidIdx = i;
        }
      }
      if (newMedoids[m] !== bestMedoidIdx) {
        newMedoids[m] = bestMedoidIdx;
        changed = true;
      }
    }
    medoids = newMedoids;
  }

  const clusters = Array.from({ length: k }, () => []);
  // Map main land lots to clusters
  for (let i = 0; i < nMain; i++) {
    clusters[assignments[i]].push(landLots[mainLandIndices[i]].id);
  }

  // Handle isolated islands: reassign to nearest parish based on Euclidean distance
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

function buildLotGraph(map, landLots, algorithm) {
  const lotIdToIndex = new Map(landLots.map((lot, i) => [lot.id, i]));
  const n = landLots.length;
  const adj = Array.from({ length: n }, () => []);

  map.segments.forEach(segment => {
    const l1 = segment.leftLotId;
    const r1 = segment.rightLotId;
    if (lotIdToIndex.has(l1) && lotIdToIndex.has(r1)) {
      const i = lotIdToIndex.get(l1);
      const j = lotIdToIndex.get(r1);
      const lotA = landLots[i];
      const lotB = landLots[j];
      
      const mid = segment.midpoint;
      // "distance between centroid and edge vertices computed by euclidean distance"
      let weight = pointDistance(lotA.centroid, mid) + pointDistance(mid, lotB.centroid);
      
      if (algorithm === "graph_river_penalty" && segment.features?.river) {
        weight *= 2;
      }
      
      adj[i].push({ to: j, weight });
      adj[j].push({ to: i, weight });
    }
  });
  return adj;
}

function computeAllPairsDistances(n, adj) {
  const dists = Array.from({ length: n }, () => new Float32Array(n).fill(Infinity));
  for (let start = 0; start < n; start++) {
    const d = dists[start];
    d[start] = 0;
    const pq = new MinPriorityQueue();
    pq.push(start, 0);
    while (!pq.isEmpty()) {
      const { node, priority: dist } = pq.pop();
      if (dist > d[node]) continue;
      for (const edge of adj[node]) {
        const newDist = dist + edge.weight;
        if (newDist < d[edge.to]) {
          d[edge.to] = newDist;
          pq.push(edge.to, newDist);
        }
      }
    }
  }
  return dists;
}

class MinPriorityQueue {
  constructor() {
    this.heap = [];
  }
  push(node, priority) {
    this.heap.push({ node, priority });
    this.bubbleUp();
  }
  pop() {
    if (this.isEmpty()) return null;
    if (this.heap.length === 1) return this.heap.pop();
    const top = this.heap[0];
    this.heap[0] = this.heap.pop();
    this.bubbleDown();
    return top;
  }
  bubbleUp() {
    let index = this.heap.length - 1;
    while (index > 0) {
      let parent = Math.floor((index - 1) / 2);
      if (this.heap[index].priority >= this.heap[parent].priority) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }
  bubbleDown() {
    let index = 0;
    while (true) {
      let left = 2 * index + 1;
      let right = 2 * index + 2;
      let smallest = index;
      if (left < this.heap.length && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < this.heap.length && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === index) break;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
  isEmpty() { return this.heap.length === 0; }
}

function sampleIndices(n, k, rng) {
  const indices = Array.from({ length: n }, (_, i) => i);
  const result = [];
  for (let i = 0; i < k && indices.length > 0; i++) {
    const idx = Math.floor(rng.next() * indices.length);
    result.push(indices.splice(idx, 1)[0]);
  }
  return result;
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
