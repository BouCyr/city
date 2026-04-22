import { createSeededRandom } from "./random.js";
import { buildVoronoiDiagram } from "../lib/voronoi-client.js";
import { GENERATION_STEPS } from "./steps.js";

export async function generateCity(options, stepTracker) {
  stepTracker.reset();

  const rng = createSeededRandom(options.seed);
  const frames = [createFrame("Blank canvas", null)];
  const initialPoints = await stepTracker.advance(0, "Points", async () => scatterPoints(rng, options));
  frames.push(
    createFrame("Step 1 / Scattered points", {
      points: initialPoints,
      cells: [],
      edges: [],
      water: { sides: [], seaCellIds: [] },
    }),
  );
  const initialDiagram = await stepTracker.advance(1, "Voronoi", async () =>
    buildVoronoiDiagram({ points: initialPoints, width: options.mapSize, height: options.mapSize }),
  );
  frames.push(createFrame("Step 2 / Raw Voronoi diagram", createMapShape(initialPoints, initialDiagram, options, null)));
  const initialWater = await stepTracker.advance(2, "Water", async () => applyWater(rng, initialDiagram, options));
  frames.push(createFrame("Step 3 / Water classification", createMapShape(initialPoints, initialDiagram, options, initialWater)));
  const points = await stepTracker.advance(3, "Lloyd", async () => relaxPoints(initialDiagram, options.mapSize));
  const diagram = buildVoronoiDiagram({ points, width: options.mapSize, height: options.mapSize });
  const water = applyWater(rng, diagram, options);
  frames.push(createFrame("Step 4 / Lloyd-smoothed map", createMapShape(points, diagram, options, water)));
  const cityCenterCellId = await stepTracker.advance(4, "Center", async () => chooseCityCenterCell(diagram, options));
  frames.push(createFrame("Step 5 / City center", createMapShape(points, diagram, options, water, cityCenterCellId)));
  stepTracker.complete();

  const finalMap = {
    ...createMapShape(points, diagram, options, water, cityCenterCellId),
    summary: {
      pointCount: points.length,
      cellCount: diagram.cells.length,
      edgeCount: diagram.edges.length,
      seaCellCount: water.seaCellIds.length,
    },
    steps: GENERATION_STEPS,
    frames,
  };

  return {
    ...finalMap,
  };
}

function scatterPoints(rng, options) {
  const padding = options.mapSize * 0.0;
  return Array.from({ length: options.pointCount }, (_, index) => ({
    id: index,
    x: rng.between(padding, options.mapSize - padding),
    y: rng.between(padding, options.mapSize - padding),
  }));
}

function relaxPoints(diagram, size) {
  const padding = size * 0.04;
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

function applyWater(rng, diagram, options) {
  const activeSides = options.waterSides.filter((side) => side.enabled).map((side) => side.name);
  const selected = new Set();
  const queue = [];
  const maxWaterReach = options.mapSize * 0.2;

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
    const expansionChance = 0.14 + edgePressure * 0.52;

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

function createMapShape(points, diagram, options, water, cityCenterCellId = null) {
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
    water: water || { sides: [], seaCellIds: [] },
    cityCenterCellId,
  };
}

function createFrame(label, map) {
  return map
    ? { type: "map", label, map }
    : { type: "blank", label };
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
  return 1 - Math.min(nearest / (options.mapSize * 0.42), 1);
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
  return Math.max(0, 1 - distance / (size * 0.68));
}

function distanceFromCenter(point, size) {
  return Math.hypot(point.x - size / 2, point.y - size / 2);
}
