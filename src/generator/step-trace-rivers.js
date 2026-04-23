/*
 * WHAT: Trace river networks across the canonical map and annotate touched cells and edges.
 * HOW: Pick inland boundary starts, route toward the sea through edge midpoints, and commit one river at a time.
 * WHY: Rivers are the final structural feature and need both traversal metadata and renderable geometry.
 */

import { centerBias, clamp, cross, distanceBetween, dot, normalizeVector, pointsMatch } from "./geometry.js";

const MAX_RIVER_COUNT = 4;
const MIN_RIVER_START_DISTANCE = 3;
const RIVER_START_DISTANCE_RATIO = 0.35;
const MIN_RIVER_STEPS = 12;
const RIVER_MAX_STEP_RATIO = 0.3;
const RIVER_START_POOL_SIZE = 8;
const RIVER_START_CENTER_WEIGHT = 3;
const RIVER_DISTANCE_WEIGHT = 2.8;
const RIVER_BASE_WIDTH = 2.8;
const RIVER_MERGE_WIDTH_INCREMENT = 1.1;
const RIVER_MEANDER_BIAS = 0.65;
const RIVER_TURN_WEIGHT = 0.6;
const RIVER_MEANDER_WEIGHT = 0.75;
const RIVER_MERGE_ATTRACTION = 4;
const RIVER_JITTER_WEIGHT = 0.55;
const RIVER_ATTRACTION_RADIUS_RATIO = 0.18;
const RIVER_ATTRACTION_WEIGHT = 2.2;
const CENTER_BIAS_RADIUS_RATIO = 0.68;
const RIVER_SOURCE_OUTSET = 1;

export function runTraceRiversStep(map, { rng }) {
  const rivers = traceRivers(map, rng);

  if (!rivers.length) {
    const nextMap = attachRiverData(map, []);
    return {
      map: nextMap,
      frameEntries: [
        {
          label: "Step 6 / No rivers",
          map: nextMap,
        },
      ],
    };
  }

  const frameEntries = rivers.map((_, index) => ({
    label: `Step 6 / River ${index + 1}`,
    map: attachRiverData(map, rivers.slice(0, index + 1)),
  }));

  return {
    map: frameEntries[frameEntries.length - 1].map,
    frameEntries,
  };
}

function traceRivers(map, rng) {
  const requestedCount = normalizeRiverCount(map.init.params);
  if (requestedCount === 0) {
    return [];
  }

  const seaDistances = computeSeaDistances(map);
  const adjacency = buildAdjacencyMap(map);
  const boundaryEntries = buildBoundaryEntryMap(map);
  const rivers = [];
  const occupiedCells = new Set();
  const occupiedSegments = new Set();
  const maxDistance = Math.max(...seaDistances.filter((distance) => Number.isFinite(distance)), 0);
  const minStartDistance = Math.max(MIN_RIVER_START_DISTANCE, Math.ceil(maxDistance * RIVER_START_DISTANCE_RATIO));

  for (let riverIndex = 0; riverIndex < requestedCount; riverIndex += 1) {
    const rejectedStartEdges = new Set();
    let river = null;

    while (true) {
      const startEntry = chooseRiverStartCell(
        rng,
        map,
        seaDistances,
        occupiedCells,
        minStartDistance,
        boundaryEntries,
        rejectedStartEdges,
      );

      if (!startEntry) {
        break;
      }

      river = traceSingleRiver({
        rng,
        riverIndex,
        startEntry,
        map,
        adjacency,
        seaDistances,
        existingRivers: rivers,
        occupiedCells,
        occupiedSegments,
      });

      if (river) {
        rivers.push(river);
        break;
      }

      rejectedStartEdges.add(startEntry.entry.edgeId);
    }

    if (!river) {
      break;
    }
  }

  return rivers;
}

function attachRiverData(map, rivers) {
  const riverCellIds = new Set(rivers.flatMap((river) => river.cellIds));
  const riverEdgeIds = new Set(rivers.flatMap((river) => river.edgeIds));
  const cells = map.cells.map((cell) => ({
    ...cell,
    features: {
      ...cell.features,
      river: riverCellIds.has(cell.id),
    },
  }));
  const edges = map.edges.map((edge) => ({
    ...edge,
    features: {
      ...edge.features,
      river: riverEdgeIds.has(edge.id),
    },
  }));

  return {
    ...map,
    cells,
    edges,
    rivers,
  };
}

function computeSeaDistances(map) {
  const distances = Array.from({ length: map.cells.length }, () => Infinity);
  const queue = [];

  map.cells.forEach((cell) => {
    if (cell.features.sea) {
      distances[cell.id] = 0;
      queue.push(cell.id);
    }
  });

  while (queue.length > 0) {
    const cellId = queue.shift();
    const nextDistance = distances[cellId] + 1;

    map.cells[cellId].neighborCellIds.forEach((neighborId) => {
      if (nextDistance >= distances[neighborId]) {
        return;
      }

      distances[neighborId] = nextDistance;
      queue.push(neighborId);
    });
  }

  return distances;
}

function buildAdjacencyMap(map) {
  const lookup = new Map();

  map.edges.forEach((edge) => {
    if (edge.leftCellId === null || edge.rightCellId === null) {
      return;
    }

    lookup.set(edgeKey(edge.leftCellId, edge.rightCellId), {
      edgeId: edge.id,
      from: edge.from,
      midpoint: edge.midpoint,
      to: edge.to,
    });
  });

  return lookup;
}

function buildBoundaryEntryMap(map) {
  const lookup = new Map();

  map.edges.forEach((edge) => {
    if (!edge.features.boundary || !isCanvasBoundaryEdge(edge, map.meta.size)) {
      return;
    }

    const cellId = edge.leftCellId ?? edge.rightCellId;
    if (cellId === null) {
      return;
    }

    const entries = lookup.get(cellId) || [];
    entries.push({
      edgeId: edge.id,
      from: edge.from,
      midpoint: edge.midpoint,
      to: edge.to,
    });
    lookup.set(cellId, entries);
  });

  return lookup;
}

function chooseRiverStartCell(rng, map, seaDistances, occupiedCells, minStartDistance, boundaryEntries, rejectedStartEdges) {
  const candidates = map.cells
    .filter((cell) => {
      if (!cell.features.boundary) {
        return false;
      }
      const entries = (boundaryEntries.get(cell.id) || []).filter((entry) => !rejectedStartEdges.has(entry.edgeId));
      return !cell.features.sea && !occupiedCells.has(cell.id) && seaDistances[cell.id] >= 1 && entries.length > 0;
    })
    .map((cell) => {
      const entries = (boundaryEntries.get(cell.id) || []).filter((entry) => !rejectedStartEdges.has(entry.edgeId));
      const inlandBonus = Math.max(0, seaDistances[cell.id] - minStartDistance);
      const nearSeaPenalty = Math.max(0, minStartDistance - seaDistances[cell.id]);
      return {
        cellId: cell.id,
        entry: entries[Math.floor(rng.next() * entries.length)],
        score:
          seaDistances[cell.id]
          + inlandBonus
          - nearSeaPenalty * 1.5
          + centerBias(cell.centroid, map.meta.size, CENTER_BIAS_RADIUS_RATIO) * RIVER_START_CENTER_WEIGHT,
      };
    })
    .sort((first, second) => second.score - first.score);

  if (!candidates.length) {
    return null;
  }

  const poolSize = Math.min(RIVER_START_POOL_SIZE, candidates.length);
  return candidates[Math.floor(rng.next() * poolSize)] || null;
}

function traceSingleRiver({
  rng,
  riverIndex,
  startEntry,
  map,
  adjacency,
  seaDistances,
  existingRivers,
  occupiedCells,
  occupiedSegments,
}) {
  const startCellId = startEntry.cellId;
  const riverCells = new Set([startCellId]);
  const committedCells = new Set([startCellId]);
  const committedSegments = new Set();
  const sourcePoint = projectBoundarySourcePoint(startEntry.entry, map.meta.size);
  const path = [sourcePoint];
  const segments = [];
  const traversal = [
    { type: "edge", edgeId: startEntry.entry.edgeId },
    { type: "cell", cellId: startCellId },
  ];
  const edgeIds = [startEntry.entry.edgeId];
  let currentCellId = startCellId;
  let previousCellId = null;
  let previousDirection = null;
  let currentEntryPoint = sourcePoint;
  let currentEntryEdge = startEntry.entry;
  let termination = "stalled";
  let endCellId = startCellId;
  let mergeTarget = null;
  const maxSteps = Math.max(MIN_RIVER_STEPS, Math.ceil(map.cells.length * RIVER_MAX_STEP_RATIO));

  for (let step = 0; step < maxSteps; step += 1) {
    const currentCell = map.cells[currentCellId];
    const nextChoice = chooseRiverNeighbor({
      rng,
      riverIndex,
      currentCell,
      previousCellId,
      previousDirection,
      currentEntryPoint,
      currentEntryEdge,
      map,
      adjacency,
      seaDistances,
      existingRivers,
      occupiedCells,
      occupiedSegments,
      riverCells,
    });

    if (!nextChoice) {
      break;
    }

    edgeIds.push(nextChoice.edgeId);
    traversal.push({ type: "edge", edgeId: nextChoice.edgeId });

    if (step === 0) {
      path.push(nextChoice.midpoint);
      segments.push({
        from: currentEntryPoint,
        to: nextChoice.midpoint,
        cellId: currentCellId,
        edgeId: nextChoice.edgeId,
        width: RIVER_BASE_WIDTH,
      });
    } else {
      path.push(currentCell.centroid);
      path.push(nextChoice.midpoint);
      segments.push({
        from: currentEntryPoint,
        to: currentCell.centroid,
        cellId: currentCellId,
        edgeId: currentEntryEdge.edgeId,
        width: RIVER_BASE_WIDTH,
      });
      segments.push({
        from: currentCell.centroid,
        to: nextChoice.midpoint,
        cellId: currentCellId,
        edgeId: nextChoice.edgeId,
        width: RIVER_BASE_WIDTH,
      });
    }
    committedSegments.add(nextChoice.edgeId);

    if (nextChoice.termination === "sea") {
      riverCells.add(nextChoice.targetCellId);
      traversal.push({ type: "cell", cellId: nextChoice.targetCellId });
      endCellId = nextChoice.targetCellId;
      termination = "sea";
      break;
    }

    if (nextChoice.termination === "merge") {
      riverCells.add(nextChoice.targetCellId);
      traversal.push({ type: "cell", cellId: nextChoice.targetCellId });
      path.push(nextChoice.mergePoint);
      segments.push({
        from: nextChoice.midpoint,
        to: nextChoice.mergePoint,
        cellId: nextChoice.targetCellId,
        edgeId: nextChoice.edgeId,
        width: RIVER_BASE_WIDTH,
      });
      endCellId = nextChoice.targetCellId;
      mergeTarget = nextChoice;
      termination = "merge";
      break;
    }

    const nextCell = map.cells[nextChoice.targetCellId];
    committedCells.add(nextCell.id);
    riverCells.add(nextCell.id);
    traversal.push({ type: "cell", cellId: nextCell.id });
    previousDirection = normalizeVector(
      nextChoice.midpoint.x - currentCell.centroid.x,
      nextChoice.midpoint.y - currentCell.centroid.y,
    );
    previousCellId = currentCellId;
    currentCellId = nextCell.id;
    currentEntryPoint = nextChoice.midpoint;
    currentEntryEdge = nextChoice.edge;
  }

  if (termination !== "sea" && termination !== "merge") {
    return null;
  }

  committedCells.forEach((cellId) => occupiedCells.add(cellId));
  committedSegments.forEach((edgeId) => occupiedSegments.add(edgeId));

  if (mergeTarget) {
    strengthenRiverFromMerge(existingRivers[mergeTarget.mergeRiverIndex], mergeTarget.targetCellId);
  }

  return {
    id: riverIndex,
    startCellId,
    endCellId,
    termination,
    traversal,
    cellIds: Array.from(riverCells),
    edgeIds,
    path,
    segments,
  };
}

function chooseRiverNeighbor({
  rng,
  riverIndex,
  currentCell,
  previousCellId,
  previousDirection,
  currentEntryPoint,
  currentEntryEdge,
  map,
  adjacency,
  seaDistances,
  existingRivers,
  occupiedCells,
  occupiedSegments,
  riverCells,
}) {
  const meanderBias = (riverIndex % 2 === 0 ? 1 : -1) * RIVER_MEANDER_BIAS;
  const options = [];

  currentCell.neighborCellIds.forEach((neighborId) => {
    if (neighborId === previousCellId || riverCells.has(neighborId)) {
      return;
    }

    const neighbor = map.cells[neighborId];
    const edge = adjacency.get(edgeKey(currentCell.id, neighborId));
    if (!edge || occupiedSegments.has(edge.edgeId)) {
      return;
    }
    if (edgesTouch(currentEntryEdge, edge)) {
      return;
    }

    const incomingDirection = normalizeVector(
      currentCell.centroid.x - currentEntryPoint.x,
      currentCell.centroid.y - currentEntryPoint.y,
    );
    const direction = normalizeVector(
      edge.midpoint.x - currentCell.centroid.x,
      edge.midpoint.y - currentCell.centroid.y,
    );
    const distanceDelta = seaDistances[currentCell.id] - seaDistances[neighborId];
    const mergeTarget = findMergeTarget(existingRivers, neighborId);
    const touchingRiver = mergeTarget !== null;

    if (!neighbor.features.sea && !touchingRiver && occupiedCells.has(neighborId)) {
      return;
    }

    if (!neighbor.features.sea && !touchingRiver && distanceDelta < 1) {
      return;
    }

    const referenceDirection = previousDirection || incomingDirection;
    const straightness = dot(referenceDirection, direction);
    const bend = cross(referenceDirection, direction);
    const turnPenalty = straightness * RIVER_TURN_WEIGHT;
    const meanderBonus = Math.abs(bend - meanderBias) * RIVER_MEANDER_WEIGHT;
    const attraction = touchingRiver ? RIVER_MERGE_ATTRACTION : riverAttraction(edge.midpoint, existingRivers, map.meta.size);
    const jitter = rng.next() * RIVER_JITTER_WEIGHT;
    const score = seaDistances[neighborId] * RIVER_DISTANCE_WEIGHT + turnPenalty + meanderBonus + jitter - attraction;

    options.push({
      edgeId: edge.edgeId,
      midpoint: edge.midpoint,
      targetCellId: neighborId,
      edge,
      mergePoint: touchingRiver ? map.cells[neighborId].centroid : null,
      mergeRiverIndex: mergeTarget,
      termination: neighbor.features.sea ? "sea" : touchingRiver ? "merge" : null,
      score,
    });
  });

  if (!options.length) {
    return null;
  }

  options.sort((first, second) => first.score - second.score);
  const bestScore = options[0].score;
  const weighted = options.map((option) => ({
    option,
    weight: 1 / (1 + Math.max(0, option.score - bestScore)),
  }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let threshold = rng.next() * totalWeight;

  for (const entry of weighted) {
    threshold -= entry.weight;
    if (threshold <= 0) {
      return entry.option;
    }
  }

  return weighted[weighted.length - 1].option;
}

function riverAttraction(point, rivers, mapSize) {
  if (!rivers.length) {
    return 0;
  }

  let nearest = Infinity;
  rivers.forEach((river) => {
    river.path.forEach((riverPoint) => {
      nearest = Math.min(nearest, distanceBetween(point, riverPoint));
    });
  });

  if (!Number.isFinite(nearest)) {
    return 0;
  }

  return Math.max(0, 1 - nearest / (mapSize * RIVER_ATTRACTION_RADIUS_RATIO)) * RIVER_ATTRACTION_WEIGHT;
}

function findMergeTarget(rivers, cellId) {
  const riverIndex = rivers.findIndex((river) => river.cellIds.includes(cellId));
  return riverIndex >= 0 ? riverIndex : null;
}

function strengthenRiverFromMerge(river, mergeCellId) {
  let shouldGrow = false;

  river.segments.forEach((segment) => {
    if (segment.cellId === mergeCellId) {
      shouldGrow = true;
    }
    if (shouldGrow) {
      segment.width = (segment.width || RIVER_BASE_WIDTH) + RIVER_MERGE_WIDTH_INCREMENT;
    }
  });
}

function normalizeRiverCount(params) {
  const waterSideCount = params.waterSides.filter((side) => side.enabled).length;
  if (waterSideCount === 4) {
    return 0;
  }

  return clamp(params.riverCount ?? 0, 0, MAX_RIVER_COUNT);
}

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function edgesTouch(first, second) {
  return (
    pointsMatch(first.from, second.from)
    || pointsMatch(first.from, second.to)
    || pointsMatch(first.to, second.from)
    || pointsMatch(first.to, second.to)
  );
}

function projectBoundarySourcePoint(entry, mapSize) {
  const midpoint = {
    x: (entry.from.x + entry.to.x) / 2,
    y: (entry.from.y + entry.to.y) / 2,
  };

  if (Math.abs(entry.from.y) <= 0.75 && Math.abs(entry.to.y) <= 0.75) {
    return { x: midpoint.x, y: -RIVER_SOURCE_OUTSET };
  }

  if (Math.abs(entry.from.y - mapSize) <= 0.75 && Math.abs(entry.to.y - mapSize) <= 0.75) {
    return { x: midpoint.x, y: mapSize + RIVER_SOURCE_OUTSET };
  }

  if (Math.abs(entry.from.x) <= 0.75 && Math.abs(entry.to.x) <= 0.75) {
    return { x: -RIVER_SOURCE_OUTSET, y: midpoint.y };
  }

  if (Math.abs(entry.from.x - mapSize) <= 0.75 && Math.abs(entry.to.x - mapSize) <= 0.75) {
    return { x: mapSize + RIVER_SOURCE_OUTSET, y: midpoint.y };
  }

  return midpoint;
}

function isCanvasBoundaryEdge(edge, mapSize, epsilon = 0.75) {
  const onNorth = Math.abs(edge.from.y) <= epsilon && Math.abs(edge.to.y) <= epsilon;
  const onSouth = Math.abs(edge.from.y - mapSize) <= epsilon && Math.abs(edge.to.y - mapSize) <= epsilon;
  const onWest = Math.abs(edge.from.x) <= epsilon && Math.abs(edge.to.x) <= epsilon;
  const onEast = Math.abs(edge.from.x - mapSize) <= epsilon && Math.abs(edge.to.x - mapSize) <= epsilon;

  return onNorth || onSouth || onWest || onEast;
}
