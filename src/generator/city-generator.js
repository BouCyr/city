import { createSeededRandom } from "./random.js";
import { buildVoronoiDiagram } from "../lib/voronoi-client.js";
import { GENERATION_STEPS } from "./steps.js";

export async function generateCity(options, stepTracker) {
  stepTracker.reset();

  const rng = createSeededRandom(options.seed);
  const points = await stepTracker.advance(0, "Points", async () => scatterPoints(rng, options));
  const diagram = await stepTracker.advance(1, "Voronoi", async () =>
    buildVoronoiDiagram({ points, width: options.mapSize, height: options.mapSize }),
  );
  const water = await stepTracker.advance(2, "Water", async () => applyWater(rng, diagram, options));
  stepTracker.complete();

  return {
    seed: options.seed,
    size: options.mapSize,
    points,
    cells: diagram.cells,
    edges: diagram.edges,
    water,
    summary: {
      pointCount: points.length,
      cellCount: diagram.cells.length,
      edgeCount: diagram.edges.length,
      seaCellCount: water.seaCellIds.length,
    },
    steps: GENERATION_STEPS,
  };
}

function scatterPoints(rng, options) {
  const padding = options.mapSize * 0.04;
  return Array.from({ length: options.pointCount }, (_, index) => ({
    id: index,
    x: rng.between(padding, options.mapSize - padding),
    y: rng.between(padding, options.mapSize - padding),
  }));
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
    const second = diagram.cells[edge.b];
    edge.kind = first.isSea && second.isSea ? "sea" : "land";
  }

  return {
    sides: activeSides,
    seaCellIds: Array.from(selected),
  };
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
