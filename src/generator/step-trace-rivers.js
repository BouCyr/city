/*
 * WHAT: Trace river networks across the canonical map and annotate touched cells and edges.
 * HOW: Pick inland boundary starts, route one trunk river to the sea, then force later rivers to merge as tributaries.
 * WHY: Rivers should read as a connected drainage system with one outlet, distinct sources, and named confluences.
 */

import { centerBias, clamp, cross, distanceBetween, dot, normalizeVector, pointsMatch } from "./geometry.js";

const MAX_RIVER_COUNT = 4;
const MIN_RIVER_START_DISTANCE = 5;
const RIVER_START_DISTANCE_RATIO = 0.55;
const MIN_RIVER_STEPS = 12;
const RIVER_MAX_STEP_RATIO = 0.3;
const RIVER_START_POOL_SIZE = 8;
const RIVER_START_CENTER_WEIGHT = 3;
const RIVER_DISTANCE_WEIGHT = 2.8;
const RIVER_BASE_WIDTH = 2.8;
const RIVER_FLOW_WIDTH_INCREMENT = 0.7;
const RIVER_MEANDER_BIAS = 0.65;
const RIVER_TURN_WEIGHT = 0.6;
const RIVER_MEANDER_WEIGHT = 0.75;
const RIVER_MERGE_ATTRACTION = 7;
const RIVER_JITTER_WEIGHT = 0.55;
const RIVER_ATTRACTION_RADIUS_RATIO = 0.18;
const RIVER_ATTRACTION_WEIGHT = 2.2;
const CENTER_BIAS_RADIUS_RATIO = 0.68;
const RIVER_SOURCE_OUTSET = 1;
const RIVER_NAMES = [
  "Valdombra",
  "Fiume Serrano",
  "Torrente Belloro",
  "Rio Castellano",
  "Fiumara Lucente",
  "Torrente Virelli",
  "Rio Montesco",
  "Fiume Caldoro",
  "Torrente Azzurri",
  "Rio Ventoro",
];

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

  const riverNames = chooseRiverNames(rng, requestedCount);
  const seaDistances = computeSeaDistances(map);
  const adjacency = buildAdjacencyMap(map);
  const boundaryEntries = buildBoundaryEntryMap(map);
  const rivers = [];
  const occupiedCells = new Set();
  const occupiedSegments = new Set();
  const maxDistance = Math.max(...seaDistances.filter((distance) => Number.isFinite(distance)), 0);
  const minStartDistance = Math.max(MIN_RIVER_START_DISTANCE, Math.ceil(maxDistance * RIVER_START_DISTANCE_RATIO));
  let seaRiverId = null;

  console.debug("[rivers] start", {
    requestedCount,
    maxDistance,
    preferredMinStartDistance: minStartDistance,
    boundaryEntryCellCount: boundaryEntries.size,
  });

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
        console.debug("[rivers] no valid start entry left", {
          riverIndex,
          rejectedStartEdges: rejectedStartEdges.size,
          allowSeaTermination: seaRiverId === null,
        });
        break;
      }

      river = traceSingleRiver({
        rng,
        riverIndex,
        riverName: riverNames[riverIndex],
        sourceWater: initialSourceWater(riverIndex, requestedCount),
        allowSeaTermination: seaRiverId === null,
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
        console.debug("[rivers] committed", {
          riverIndex,
          name: river.name,
          termination: river.termination,
          sourceWater: river.sourceWater,
          totalWater: river.totalWater,
          cellCount: river.cellIds.length,
          edgeCount: river.edgeIds.length,
        });
        if (river.termination === "sea") {
          seaRiverId = river.id;
        }
        break;
      }

      console.debug("[rivers] rejected start entry after failed trace", {
        riverIndex,
        startCellId: startEntry.cellId,
        startEdgeId: startEntry.entry.edgeId,
      });
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
  // Prefer starts far from the sea, but do not hard-fail generation when the coastline
  // leaves too few true boundary cells at that preferred distance.
  const preferredCandidates = collectStartCandidates(
    rng,
    map,
    seaDistances,
    occupiedCells,
    minStartDistance,
    boundaryEntries,
    rejectedStartEdges,
  );
  const fallbackCandidates = preferredCandidates.length
    ? preferredCandidates
    : collectStartCandidates(
        rng,
        map,
        seaDistances,
        occupiedCells,
        Math.max(1, Math.floor(minStartDistance * 0.5)),
        boundaryEntries,
        rejectedStartEdges,
      );
  const candidates = fallbackCandidates;

  if (!candidates.length) {
    console.debug("[rivers] no start candidates", {
      preferredMinStartDistance: minStartDistance,
      fallbackMinStartDistance: Math.max(1, Math.floor(minStartDistance * 0.5)),
      rejectedStartEdges: rejectedStartEdges.size,
      occupiedCells: occupiedCells.size,
    });
    return null;
  }

  if (preferredCandidates.length === 0) {
    console.debug("[rivers] falling back to a closer-to-sea start threshold", {
      preferredMinStartDistance: minStartDistance,
      fallbackMinStartDistance: Math.max(1, Math.floor(minStartDistance * 0.5)),
      candidateCount: candidates.length,
    });
  }

  const poolSize = Math.min(RIVER_START_POOL_SIZE, candidates.length);
  return candidates[Math.floor(rng.next() * poolSize)] || null;
}

function collectStartCandidates(rng, map, seaDistances, occupiedCells, minDistance, boundaryEntries, rejectedStartEdges) {
  return map.cells
    .filter((cell) => {
      if (!cell.features.boundary) {
        return false;
      }

      const entries = (boundaryEntries.get(cell.id) || []).filter((entry) => !rejectedStartEdges.has(entry.edgeId));
      return !cell.features.sea && !occupiedCells.has(cell.id) && seaDistances[cell.id] >= minDistance && entries.length > 0;
    })
    .map((cell) => {
      const entries = (boundaryEntries.get(cell.id) || []).filter((entry) => !rejectedStartEdges.has(entry.edgeId));
      return {
        cellId: cell.id,
        entry: entries[Math.floor(rng.next() * entries.length)],
        score:
          seaDistances[cell.id] * 2
          + centerBias(cell.centroid, map.meta.size, CENTER_BIAS_RADIUS_RATIO) * RIVER_START_CENTER_WEIGHT,
      };
    })
    .sort((first, second) => second.score - first.score);
}

function traceSingleRiver({
  rng,
  riverIndex,
  riverName,
  sourceWater,
  allowSeaTermination,
  startEntry,
  map,
  adjacency,
  seaDistances,
  existingRivers,
  occupiedCells,
  occupiedSegments,
}) {
  // Each traced river carries its own source flow. At merges we add that flow to the
  // receiver river downstream from the confluence only.
  const startCellId = startEntry.cellId;
  const riverCells = new Set([startCellId]);
  const committedCells = new Set([startCellId]);
  const committedSegments = new Set();
  const sourcePoint = projectBoundarySourcePoint(startEntry.entry, map.meta.size);
  const path = [sourcePoint];
  const segments = [];
  const traversal = [
    { type: "edge", edgeId: startEntry.entry.edgeId, waterAmount: sourceWater },
    { type: "cell", cellId: startCellId, waterAmount: sourceWater },
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
      allowSeaTermination,
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
      console.debug("[rivers] trace stalled", {
        riverIndex,
        riverName,
        step,
        currentCellId,
        allowSeaTermination,
      });
      break;
    }

    edgeIds.push(nextChoice.edgeId);
    traversal.push({ type: "edge", edgeId: nextChoice.edgeId, waterAmount: sourceWater });

    if (step === 0) {
      path.push(nextChoice.midpoint);
      segments.push(createRiverSegment(currentEntryPoint, nextChoice.midpoint, currentCellId, nextChoice.edgeId, sourceWater));
    } else {
      path.push(currentCell.centroid);
      path.push(nextChoice.midpoint);
      segments.push(createRiverSegment(currentEntryPoint, currentCell.centroid, currentCellId, currentEntryEdge.edgeId, sourceWater));
      segments.push(createRiverSegment(currentCell.centroid, nextChoice.midpoint, currentCellId, nextChoice.edgeId, sourceWater));
    }
    committedSegments.add(nextChoice.edgeId);

    if (nextChoice.termination === "sea") {
      riverCells.add(nextChoice.targetCellId);
      traversal.push({ type: "cell", cellId: nextChoice.targetCellId, waterAmount: sourceWater });
      endCellId = nextChoice.targetCellId;
      termination = "sea";
      break;
    }

    if (nextChoice.termination === "merge") {
      riverCells.add(nextChoice.targetCellId);
      traversal.push({ type: "cell", cellId: nextChoice.targetCellId, waterAmount: sourceWater });
      path.push(nextChoice.mergePoint);
      segments.push(createRiverSegment(nextChoice.midpoint, nextChoice.mergePoint, nextChoice.targetCellId, nextChoice.edgeId, sourceWater));
      endCellId = nextChoice.targetCellId;
      mergeTarget = nextChoice;
      termination = "merge";
      break;
    }

    const nextCell = map.cells[nextChoice.targetCellId];
    committedCells.add(nextCell.id);
    riverCells.add(nextCell.id);
    traversal.push({ type: "cell", cellId: nextCell.id, waterAmount: sourceWater });
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
    console.debug("[rivers] discarded traced path", {
      riverIndex,
      riverName,
      startCellId,
      endCellId,
      reason: termination,
      traversedCells: riverCells.size,
    });
    return null;
  }

  const river = {
    id: riverIndex,
    name: riverName,
    startCellId,
    endCellId,
    termination,
    sourceWater,
    totalWater: sourceWater,
    traversal,
    cellIds: Array.from(riverCells),
    edgeIds,
    path,
    segments,
    sourceOrder: riverIndex,
  };

  committedCells.forEach((cellId) => occupiedCells.add(cellId));
  committedSegments.forEach((edgeId) => occupiedSegments.add(edgeId));

  if (mergeTarget) {
    const receiver = existingRivers[mergeTarget.mergeRiverIndex];
    integrateTributary(receiver, river, mergeTarget.targetCellId);
  }

  return river;
}

function chooseRiverNeighbor({
  rng,
  riverIndex,
  allowSeaTermination,
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
  const rejectionCounts = {
    backtrackOrLoop: 0,
    missingOrOccupiedEdge: 0,
    touchingEntryEdge: 0,
    seaBlocked: 0,
    occupiedLandCell: 0,
    notDownhillEnough: 0,
  };

  currentCell.neighborCellIds.forEach((neighborId) => {
    if (neighborId === previousCellId || riverCells.has(neighborId)) {
      rejectionCounts.backtrackOrLoop += 1;
      return;
    }

    const neighbor = map.cells[neighborId];
    const edge = adjacency.get(edgeKey(currentCell.id, neighborId));
    if (!edge || occupiedSegments.has(edge.edgeId)) {
      rejectionCounts.missingOrOccupiedEdge += 1;
      return;
    }
    if (edgesTouch(currentEntryEdge, edge)) {
      rejectionCounts.touchingEntryEdge += 1;
      return;
    }

    const mergeTarget = findMergeTarget(existingRivers, neighborId);
    const touchingRiver = mergeTarget !== null;
    if (neighbor.features.sea && !allowSeaTermination) {
      rejectionCounts.seaBlocked += 1;
      return;
    }
    if (!neighbor.features.sea && !touchingRiver && occupiedCells.has(neighborId)) {
      rejectionCounts.occupiedLandCell += 1;
      return;
    }

    const distanceDelta = seaDistances[currentCell.id] - seaDistances[neighborId];
    if (!neighbor.features.sea && !touchingRiver && distanceDelta < 0) {
      rejectionCounts.notDownhillEnough += 1;
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
    console.debug("[rivers] no neighbor candidates", {
      riverIndex,
      currentCellId: currentCell.id,
      allowSeaTermination,
      rejectionCounts,
    });
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

function integrateTributary(receiver, tributary, mergeCellId) {
  // Confluence naming rule:
  // 1. more water wins
  // 2. if equal, longer river wins
  // 3. if equal, older source wins
  const winningName = dominantRiverName(receiver, tributary);
  receiver.totalWater += tributary.totalWater;
  receiver.name = winningName;
  console.debug("[rivers] merge", {
    receiverId: receiver.id,
    receiverName: receiver.name,
    tributaryId: tributary.id,
    tributaryName: tributary.name,
    mergeCellId,
    totalWaterAfterMerge: receiver.totalWater,
  });

  let downstream = false;
  receiver.traversal = receiver.traversal.map((part) => {
    if (!downstream && part.type === "cell" && part.cellId === mergeCellId) {
      downstream = true;
    }

    if (!downstream) {
      return part;
    }

    return {
      ...part,
      waterAmount: (part.waterAmount || receiver.sourceWater) + tributary.totalWater,
    };
  });

  downstream = false;
  receiver.segments = receiver.segments.map((segment) => {
    if (!downstream && segment.cellId === mergeCellId) {
      downstream = true;
    }

    if (!downstream) {
      return segment;
    }

    const waterAmount = (segment.waterAmount || receiver.sourceWater) + tributary.totalWater;
    return {
      ...segment,
      waterAmount,
      width: riverWidthForWater(waterAmount),
    };
  });
}

function dominantRiverName(first, second) {
  if (first.totalWater !== second.totalWater) {
    return first.totalWater > second.totalWater ? first.name : second.name;
  }

  const firstLength = riverLength(first);
  const secondLength = riverLength(second);
  if (firstLength !== secondLength) {
    return firstLength > secondLength ? first.name : second.name;
  }

  return first.sourceOrder <= second.sourceOrder ? first.name : second.name;
}

function riverLength(river) {
  return river.segments.reduce((sum, segment) => sum + distanceBetween(segment.from, segment.to), 0);
}

function createRiverSegment(from, to, cellId, edgeId, waterAmount) {
  return {
    from,
    to,
    cellId,
    edgeId,
    waterAmount,
    width: riverWidthForWater(waterAmount),
  };
}

function riverWidthForWater(waterAmount) {
  return RIVER_BASE_WIDTH + Math.max(0, waterAmount - 1) * RIVER_FLOW_WIDTH_INCREMENT;
}

function chooseRiverNames(rng, count) {
  const names = [...RIVER_NAMES];
  for (let index = names.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng.next() * (index + 1));
    [names[index], names[swapIndex]] = [names[swapIndex], names[index]];
  }

  return Array.from({ length: count }, (_, index) => names[index % names.length]);
}

function initialSourceWater(riverIndex, requestedCount) {
  return requestedCount - riverIndex + 1;
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
