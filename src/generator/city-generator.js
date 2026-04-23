/*
 * WHAT: Build deterministic city-map states and replay frames from the normalized form options.
 * HOW: Scatter points, derive Voronoi geometry, classify water, place the city center, and trace rivers step by step.
 * WHY: The UI needs both a final map and a replayable history of how that map was produced.
 */

import { createSeededRandom } from "./random.js";
import { buildVoronoiDiagram } from "../lib/voronoi-client.js";
import { GENERATION_STEPS } from "./steps.js";

const BLANK_STEP_INDEX = -1;
const STEP_POINTS = 0;
const STEP_VORONOI = 1;
const STEP_WATER = 2;
const STEP_LLOYD = 3;
const STEP_CENTER = 4;
const STEP_RIVERS = 5;
const MAX_RIVER_COUNT = 4;
const SCATTER_PADDING_RATIO = 0.01;
const RELAX_PADDING_RATIO = 0.04;
const WATER_REACH_RATIO = 0.2;
const WATER_EXPANSION_BASE = 0.14;
const WATER_EXPANSION_EDGE_WEIGHT = 0.52;
const PRESSURE_RANGE_RATIO = 0.42;
const CENTER_BIAS_RADIUS_RATIO = 0.68;
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
const RIVER_SOURCE_OUTSET = 1;

/**
 * WHAT: Produce the full deterministic map result together with one replay frame per major generation step.
 * HOW: Advance the step tracker through each stage, snapshot intermediate map states, and return the final annotated map.
 * WHY: The UI needs both the finished geometry and a stable history it can step through or autoplay.
 */
export async function generateCity(options, stepTracker) {
  stepTracker.reset();

  const rng = createSeededRandom(options.seed);
  const frames = [createFrame("Blank map", null, BLANK_STEP_INDEX)];
  const initialPoints = await stepTracker.advance(STEP_POINTS, "Points", async () => scatterPoints(rng, options));
  frames.push(
    createFrame(
      "Step 1 / Scattered points",
      {
        points: initialPoints,
        cells: [],
        edges: [],
        rivers: [],
        water: { sides: [], seaCellIds: [] },
      },
      STEP_POINTS,
    ),
  );
  const initialDiagram = await stepTracker.advance(STEP_VORONOI, "Voronoi", async () =>
    buildVoronoiDiagram({ points: initialPoints, width: options.mapSize, height: options.mapSize }),
  );
  frames.push(createFrame("Step 2 / Raw Voronoi diagram", createMapShape(initialPoints, initialDiagram, options, null), STEP_VORONOI));
  const initialWater = await stepTracker.advance(STEP_WATER, "Water", async () => applyWater(rng, initialDiagram, options));
  frames.push(
    createFrame("Step 3 / Water classification", createMapShape(initialPoints, initialDiagram, options, initialWater), STEP_WATER),
  );
  const points = await stepTracker.advance(STEP_LLOYD, "Lloyd", async () => relaxPoints(initialDiagram, options.mapSize));
  const diagram = buildVoronoiDiagram({ points, width: options.mapSize, height: options.mapSize });
  const water = applyWater(rng, diagram, options);
  frames.push(createFrame("Step 4 / Lloyd-smoothed map", createMapShape(points, diagram, options, water), STEP_LLOYD));
  const cityCenterCellId = await stepTracker.advance(STEP_CENTER, "Center", async () => chooseCityCenterCell(diagram, options));
  frames.push(createFrame("Step 5 / City center", createMapShape(points, diagram, options, water, cityCenterCellId), STEP_CENTER));
  const rivers = await stepTracker.advance(STEP_RIVERS, "Rivers", async () => traceRivers(rng, diagram, options));

  if (!rivers.length) {
    frames.push(createFrame("Step 6 / No rivers", createMapShape(points, diagram, options, water, cityCenterCellId, []), STEP_RIVERS));
  } else {
    rivers.forEach((_, index) => {
      frames.push(
        createFrame(
          `Step 6 / River ${index + 1}`,
          createMapShape(points, diagram, options, water, cityCenterCellId, rivers.slice(0, index + 1)),
          STEP_RIVERS,
        ),
      );
    });
  }

  stepTracker.complete();

  const finalMap = {
    ...createMapShape(points, diagram, options, water, cityCenterCellId, rivers),
    summary: {
      pointCount: points.length,
      cellCount: diagram.cells.length,
      edgeCount: diagram.edges.length,
      seaCellCount: water.seaCellIds.length,
      riverCount: rivers.length,
    },
    steps: GENERATION_STEPS,
    frames,
  };

  return {
    ...finalMap,
  };
}

function scatterPoints(rng, options) {
  const padding = options.mapSize * SCATTER_PADDING_RATIO;
  return Array.from({ length: options.pointCount }, (_, index) => ({
    id: index,
    x: rng.between(padding, options.mapSize - padding),
    y: rng.between(padding, options.mapSize - padding),
  }));
}

function relaxPoints(diagram, size) {
  const padding = size * RELAX_PADDING_RATIO;
  const protectedCellIds = collectProtectedCellIds(diagram);
  return diagram.cells.map((cell) => ({
    id: cell.site.id,
    x: protectedCellIds.has(cell.id) ? cell.site.x : clamp(cell.centroid.x, padding, size - padding),
    y: protectedCellIds.has(cell.id) ? cell.site.y : clamp(cell.centroid.y, padding, size - padding),
  }));
}

function collectProtectedCellIds(diagram) {
  const protectedCellIds = new Set();
  const sideCellIds = new Set(
    diagram.cells.filter((cell) => Object.values(cell.touches).some(Boolean)).map((cell) => cell.id),
  );

  for (const cellId of sideCellIds) {
    protectedCellIds.add(cellId);
  }

  for (const cell of diagram.cells) {
    if (cell.neighbors.some((neighborId) => sideCellIds.has(neighborId))) {
      protectedCellIds.add(cell.id);
    }
  }

  return protectedCellIds;
}

/**
 * WHAT: Classify which cells belong to the sea for the current diagram.
 * HOW: Seed water from the selected map borders, then flood inland probabilistically while respecting distance limits.
 * WHY: Coastline shape should feel organic while still being reproducible from the same seed and side choices.
 */
function applyWater(rng, diagram, options) {
  const activeSides = options.waterSides.filter((side) => side.enabled).map((side) => side.name);
  const selected = new Set();
  const queue = [];
  const maxWaterReach = options.mapSize * WATER_REACH_RATIO;

  for (const cell of diagram.cells) {
    if (activeSides.some((side) => cell.touches[side]) && isWithinWaterReach(cell, activeSides, options.mapSize, maxWaterReach)) {
      selected.add(cell.id);
      queue.push(cell.id);
    }
  }

  while (queue.length > 0) {
    const cellId = queue.shift();
    const cell = diagram.cells[cellId];
    const edgePressure = pressureFromSides(cell, options);
    const expansionChance = WATER_EXPANSION_BASE + edgePressure * WATER_EXPANSION_EDGE_WEIGHT;

    for (const neighborId of cell.neighbors) {
      if (selected.has(neighborId)) {
        continue;
      }

      const neighbor = diagram.cells[neighborId];
      if (!isWithinWaterReach(neighbor, activeSides, options.mapSize, maxWaterReach)) {
        continue;
      }

      const inwardResistance = centerBias(neighbor.centroid, options.mapSize);
      if (rng.next() < expansionChance * (1 - inwardResistance)) {
        selected.add(neighborId);
        queue.push(neighborId);
      }
    }
  }

  for (const cell of diagram.cells) {
    cell.isSea = selected.has(cell.id);
  }

  for (const edge of diagram.edges) {
    const first = diagram.cells[edge.a];
    const second = edge.b === null ? null : diagram.cells[edge.b];
    edge.kind = first.isSea && second?.isSea ? "sea" : "land";
  }

  return {
    sides: activeSides,
    seaCellIds: Array.from(selected),
  };
}

function chooseCityCenterCell(diagram, options) {
  const landSides = options.waterSides.filter((side) => !side.enabled).map((side) => side.name);
  const candidates = diagram.cells.filter((cell) => !cell.isSea);

  if (candidates.length === 0) {
    return null;
  }

  if (landSides.length === 0) {
    return candidates.reduce((best, cell) => {
      const cellScore = distanceFromCenter(cell.centroid, options.mapSize);
      if (!best || cellScore < best.score) {
        return { id: cell.id, score: cellScore };
      }
      return best;
    }, null)?.id ?? null;
  }

  return candidates.reduce((best, cell) => {
    const score = Math.min(...landSides.map((side) => distanceToSide(cell.centroid, options.mapSize, side)));
    if (!best || score > best.score) {
      return { id: cell.id, score };
    }
    return best;
  }, null)?.id ?? null;
}

/**
 * WHAT: Generate up to the requested number of rivers for the current land/sea layout.
 * HOW: Repeatedly choose inland boundary starts, trace one valid river at a time, and keep only traces that end in sea or merge.
 * WHY: Rivers depend on the final coastline and on previously committed rivers, so they must be built incrementally.
 */
function traceRivers(rng, diagram, options) {
  const requestedCount = normalizeRiverCount(options);
  if (requestedCount === 0) {
    return [];
  }

  const seaDistances = computeSeaDistances(diagram);
  const adjacency = buildAdjacencyMap(diagram);
  const boundaryEntries = buildBoundaryEntryMap(diagram);
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
        diagram,
        seaDistances,
        occupiedCells,
        minStartDistance,
        options.mapSize,
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
        diagram,
        adjacency,
        seaDistances,
        existingRivers: rivers,
        occupiedCells,
        occupiedSegments,
        mapSize: options.mapSize,
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

function createMapShape(points, diagram, options, water, cityCenterCellId = null, rivers = []) {
  const seaCellIds = new Set(water?.seaCellIds || []);
  return {
    seed: options.seed,
    size: options.mapSize,
    points,
    cells: diagram.cells.map((cell) => ({
      ...cell,
      isSea: seaCellIds.has(cell.id),
      isCityCenter: cell.id === cityCenterCellId,
    })),
    edges: diagram.edges.map((edge) => ({
      ...edge,
      kind: edge.b !== null && seaCellIds.has(edge.a) && seaCellIds.has(edge.b) ? "sea" : "land",
    })),
    rivers,
    water: water || { sides: [], seaCellIds: [] },
    cityCenterCellId,
  };
}

function createFrame(label, map, stepIndex) {
  return map
    ? { type: "map", label, stepIndex, map }
    : { type: "blank", label, stepIndex };
}

/**
 * WHAT: Measure how many cell-to-cell steps each land cell is from the sea.
 * HOW: Run a breadth-first expansion starting from every sea cell in parallel.
 * WHY: Both water shaping and river routing need a cheap notion of downhill distance toward the coastline.
 */
function computeSeaDistances(diagram) {
  const distances = Array.from({ length: diagram.cells.length }, () => Infinity);
  const queue = [];

  diagram.cells.forEach((cell) => {
    if (cell.isSea) {
      distances[cell.id] = 0;
      queue.push(cell.id);
    }
  });

  while (queue.length > 0) {
    const cellId = queue.shift();
    const nextDistance = distances[cellId] + 1;

    for (const neighborId of diagram.cells[cellId].neighbors) {
      if (nextDistance >= distances[neighborId]) {
        continue;
      }

      distances[neighborId] = nextDistance;
      queue.push(neighborId);
    }
  }

  return distances;
}

function buildAdjacencyMap(diagram) {
  const lookup = new Map();

  diagram.edges.forEach((edge) => {
    if (edge.b === null) {
      return;
    }

    lookup.set(edgeKey(edge.a, edge.b), {
      edgeId: edge.id,
      from: edge.from,
      midpoint: {
        x: (edge.from.x + edge.to.x) / 2,
        y: (edge.from.y + edge.to.y) / 2,
      },
      to: edge.to,
    });
  });

  return lookup;
}

function buildBoundaryEntryMap(diagram) {
  const lookup = new Map();

  diagram.edges.forEach((edge) => {
    if (edge.b !== null) {
      return;
    }

    const entries = lookup.get(edge.a) || [];
    entries.push({
      edgeId: edge.id,
      from: edge.from,
      midpoint: {
        x: (edge.from.x + edge.to.x) / 2,
        y: (edge.from.y + edge.to.y) / 2,
      },
      to: edge.to,
    });
    lookup.set(edge.a, entries);
  });

  return lookup;
}

function chooseRiverStartCell(rng, diagram, seaDistances, occupiedCells, minStartDistance, mapSize, boundaryEntries, rejectedStartEdges) {
  const candidates = diagram.cells
    .filter((cell) => {
      const entries = (boundaryEntries.get(cell.id) || []).filter((entry) => !rejectedStartEdges.has(entry.edgeId));
      return !cell.isSea && !occupiedCells.has(cell.id) && seaDistances[cell.id] >= minStartDistance && entries.length > 0;
    })
    .map((cell) => {
      const entries = (boundaryEntries.get(cell.id) || []).filter((entry) => !rejectedStartEdges.has(entry.edgeId));
      return {
        cellId: cell.id,
        entry: entries[Math.floor(rng.next() * entries.length)],
        score: seaDistances[cell.id] + centerBias(cell.centroid, mapSize) * RIVER_START_CENTER_WEIGHT,
      };
    })
    .sort((first, second) => second.score - first.score);

  if (candidates.length === 0) {
    return null;
  }

  const poolSize = Math.min(RIVER_START_POOL_SIZE, candidates.length);
  const chosen = candidates[Math.floor(rng.next() * poolSize)];
  return chosen || null;
}

/**
 * WHAT: Trace one river from a boundary entry until it reaches sea or merges into an existing river.
 * HOW: Move through land cells one at a time, keeping the source anchored on the boundary edge and then routing through cell midpoints.
 * WHY: Rivers must obey the cell graph, avoid invalid crossings, and leave behind geometry the renderer can draw directly.
 */
function traceSingleRiver({
  rng,
  riverIndex,
  startEntry,
  diagram,
  adjacency,
  seaDistances,
  existingRivers,
  occupiedCells,
  occupiedSegments,
  mapSize,
}) {
  const startCellId = startEntry.cellId;
  const riverCells = new Set([startCellId]);
  const committedCells = new Set([startCellId]);
  const committedSegments = new Set();
  const sourcePoint = projectBoundarySourcePoint(startEntry.entry, mapSize);
  const path = [sourcePoint];
  const segments = [];
  let currentCellId = startCellId;
  let previousCellId = null;
  let previousDirection = null;
  let currentEntryPoint = sourcePoint;
  let currentEntryEdge = startEntry.entry;
  let termination = "stalled";
  let endCellId = startCellId;
  let mergeTarget = null;
  const maxSteps = Math.max(MIN_RIVER_STEPS, Math.ceil(diagram.cells.length * RIVER_MAX_STEP_RATIO));

  for (let step = 0; step < maxSteps; step += 1) {
    const currentCell = diagram.cells[currentCellId];
    const nextChoice = chooseRiverNeighbor({
      rng,
      riverIndex,
      currentCell,
      previousCellId,
      previousDirection,
      currentEntryPoint,
      currentEntryEdge,
      diagram,
      adjacency,
      seaDistances,
      existingRivers,
      occupiedCells,
      occupiedSegments,
      riverCells,
      mapSize,
    });

    if (!nextChoice) {
      break;
    }

    const segmentId = edgeKey(currentCellId, nextChoice.targetCellId);
    if (step === 0) {
      path.push(nextChoice.midpoint);
      segments.push({
        from: currentEntryPoint,
        to: nextChoice.midpoint,
        cellId: currentCellId,
        kind: "river",
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
        kind: "river",
        edgeId: currentEntryEdge.edgeId,
        width: RIVER_BASE_WIDTH,
      });
      segments.push({
        from: currentCell.centroid,
        to: nextChoice.midpoint,
        cellId: currentCellId,
        kind: "river",
        edgeId: nextChoice.edgeId,
        width: RIVER_BASE_WIDTH,
      });
    }
    committedSegments.add(segmentId);

    if (nextChoice.termination === "sea") {
      endCellId = nextChoice.targetCellId;
      termination = nextChoice.termination;
      break;
    }

    if (nextChoice.termination === "merge") {
      riverCells.add(nextChoice.targetCellId);
      path.push(nextChoice.mergePoint);
      segments.push({
        from: nextChoice.midpoint,
        to: nextChoice.mergePoint,
        cellId: nextChoice.targetCellId,
        kind: "river",
        edgeId: nextChoice.edgeId,
        width: RIVER_BASE_WIDTH,
      });
      endCellId = nextChoice.targetCellId;
      mergeTarget = nextChoice;
      termination = "merge";
      break;
    }

    const nextCell = diagram.cells[nextChoice.targetCellId];
    committedCells.add(nextCell.id);
    riverCells.add(nextCell.id);
    previousDirection = normalizeVector(nextChoice.midpoint.x - currentCell.centroid.x, nextChoice.midpoint.y - currentCell.centroid.y);
    previousCellId = currentCellId;
    currentCellId = nextCell.id;
    currentEntryPoint = nextChoice.midpoint;
    currentEntryEdge = nextChoice.edge;
  }

  if (termination !== "sea" && termination !== "merge") {
    return null;
  }

  committedCells.forEach((cellId) => occupiedCells.add(cellId));
  committedSegments.forEach((segment) => occupiedSegments.add(segment));

  if (mergeTarget) {
    strengthenRiverFromMerge(existingRivers[mergeTarget.mergeRiverIndex], mergeTarget.targetCellId);
  }

  return {
    id: riverIndex,
    startCellId,
    endCellId,
    termination,
    cellIds: Array.from(riverCells),
    path,
    segments,
  };
}

/**
 * WHAT: Choose the next legal river exit edge from the current land cell.
 * HOW: Score neighboring edges by sea distance, turning preference, meander bias, attraction to existing rivers, and randomness.
 * WHY: The river should still flow toward the sea, but without collapsing into a perfectly straight deterministic path.
 */
function chooseRiverNeighbor({
  rng,
  riverIndex,
  currentCell,
  previousCellId,
  previousDirection,
  currentEntryPoint,
  currentEntryEdge,
  diagram,
  adjacency,
  seaDistances,
  existingRivers,
  occupiedCells,
  occupiedSegments,
  riverCells,
  mapSize,
}) {
  const meanderBias = (riverIndex % 2 === 0 ? 1 : -1) * RIVER_MEANDER_BIAS;
  const options = [];

  currentCell.neighbors.forEach((neighborId) => {
    if (neighborId === previousCellId || riverCells.has(neighborId)) {
      return;
    }

    const neighbor = diagram.cells[neighborId];
    const edge = adjacency.get(edgeKey(currentCell.id, neighborId));
    if (!edge || occupiedSegments.has(edgeKey(currentCell.id, neighborId))) {
      return;
    }
    if (edgesTouch(currentEntryEdge, edge)) {
      return;
    }

    const incomingDirection = normalizeVector(
      currentCell.centroid.x - currentEntryPoint.x,
      currentCell.centroid.y - currentEntryPoint.y,
    );
    const direction = normalizeVector(edge.midpoint.x - currentCell.centroid.x, edge.midpoint.y - currentCell.centroid.y);
    const distanceDelta = seaDistances[currentCell.id] - seaDistances[neighborId];
    const mergeTarget = findMergeTarget(existingRivers, neighborId);
    const touchingRiver = mergeTarget !== null;
    if (!neighbor.isSea && !touchingRiver && occupiedCells.has(neighborId)) {
      return;
    }

    if (!neighbor.isSea && !touchingRiver && distanceDelta < 1) {
      return;
    }

    const referenceDirection = previousDirection || incomingDirection;
    const straightness = dot(referenceDirection, direction);
    const bend = cross(referenceDirection, direction);
    const turnPenalty = straightness * RIVER_TURN_WEIGHT;
    const meanderBonus = Math.abs(bend - meanderBias) * RIVER_MEANDER_WEIGHT;
    const attraction = touchingRiver ? RIVER_MERGE_ATTRACTION : riverAttraction(edge.midpoint, existingRivers, mapSize);
    const jitter = rng.next() * RIVER_JITTER_WEIGHT;
    const score = seaDistances[neighborId] * RIVER_DISTANCE_WEIGHT + turnPenalty + meanderBonus + jitter - attraction;

    options.push({
      edgeId: edge.edgeId,
      midpoint: edge.midpoint,
      targetCellId: neighborId,
      direction,
      score,
      edge,
      mergePoint: touchingRiver ? diagram.cells[neighborId].centroid : null,
      mergeRiverIndex: mergeTarget,
      termination: neighbor.isSea ? "sea" : touchingRiver ? "merge" : null,
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

function normalizeRiverCount(options) {
  const waterSideCount = options.waterSides.filter((side) => side.enabled).length;
  if (waterSideCount === 4) {
    return 0;
  }
  return clamp(options.riverCount ?? 0, 0, MAX_RIVER_COUNT);
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

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  return { x: x / length, y: y / length };
}

function dot(first, second) {
  return first.x * second.x + first.y * second.y;
}

function cross(first, second) {
  return first.x * second.y - first.y * second.x;
}

function distanceBetween(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointsMatch(first, second, epsilon = 0.75) {
  return distanceBetween(first, second) <= epsilon;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isWithinWaterReach(cell, activeSides, size, maxWaterReach) {
  if (activeSides.length === 0) {
    return false;
  }

  const nearestWaterDistance = Math.min(...activeSides.map((side) => distanceToSide(cell.centroid, size, side)));
  return nearestWaterDistance <= maxWaterReach;
}

function pressureFromSides(cell, options) {
  const distances = options.waterSides
    .filter((side) => side.enabled)
    .map((side) => distanceToSide(cell.centroid, options.mapSize, side.name));

  if (distances.length === 0) {
    return 0;
  }

  const nearest = Math.min(...distances);
  return 1 - Math.min(nearest / (options.mapSize * PRESSURE_RANGE_RATIO), 1);
}

function distanceToSide(point, size, side) {
  if (side === "north") return point.y;
  if (side === "south") return size - point.y;
  if (side === "west") return point.x;
  return size - point.x;
}

function centerBias(point, size) {
  const dx = point.x - size / 2;
  const dy = point.y - size / 2;
  const distance = Math.hypot(dx, dy);
  return Math.max(0, 1 - distance / (size * CENTER_BIAS_RADIUS_RATIO));
}

function distanceFromCenter(point, size) {
  return Math.hypot(point.x - size / 2, point.y - size / 2);
}
