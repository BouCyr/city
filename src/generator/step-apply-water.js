/*
 * WHAT: Classify which canonical cells and edges belong to the sea.
 * HOW: Seed water from the selected sides, flood inland probabilistically, and rewrite feature flags on cells and edges.
 * WHY: Coastline decisions should live in one step module and be reapplied after geometry changes.
 */

import { centerBias, distanceToSide } from "./geometry.js";

const WATER_REACH_RATIO = 0.2;
const WATER_EXPANSION_BASE = 0.14;
const WATER_EXPANSION_EDGE_WEIGHT = 0.52;
const PRESSURE_RANGE_RATIO = 0.42;
const CENTER_BIAS_RADIUS_RATIO = 0.68;

export function runApplyWaterStep(map, { rng }) {
  const nextMap = applyWaterClassification(map, rng);
  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 3 / Water classification",
        map: nextMap,
      },
    ],
  };
}

export function applyWaterClassification(map, rng) {
  const activeSides = map.init.params.waterSides
    .filter((side) => side.enabled)
    .map((side) => side.name);
  const selected = new Set();
  const queue = [];
  const maxWaterReach = map.meta.size * WATER_REACH_RATIO;

  map.cells.forEach((cell) => {
    if (activeSides.some((side) => cell.boundarySides.includes(side)) && isWithinWaterReach(cell, activeSides, map.meta.size, maxWaterReach)) {
      selected.add(cell.id);
      queue.push(cell.id);
    }
  });

  while (queue.length > 0) {
    const cellId = queue.shift();
    const cell = map.cells[cellId];
    const edgePressure = pressureFromSides(cell, map);
    const expansionChance = WATER_EXPANSION_BASE + edgePressure * WATER_EXPANSION_EDGE_WEIGHT;

    cell.neighborCellIds.forEach((neighborId) => {
      if (selected.has(neighborId)) {
        return;
      }

      const neighbor = map.cells[neighborId];
      if (!isWithinWaterReach(neighbor, activeSides, map.meta.size, maxWaterReach)) {
        return;
      }

      const inwardResistance = centerBias(neighbor.centroid, map.meta.size, CENTER_BIAS_RADIUS_RATIO);
      if (rng.next() < expansionChance * (1 - inwardResistance)) {
        selected.add(neighborId);
        queue.push(neighborId);
      }
    });
  }

  const cells = map.cells.map((cell) => {
    const isSea = selected.has(cell.id);
    return {
      ...cell,
      features: {
        ...cell.features,
        sea: isSea,
        land: !isSea,
      },
    };
  });
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const edges = map.edges.map((edge) => {
    const leftCell = edge.leftCellId === null ? null : cellById.get(edge.leftCellId);
    const rightCell = edge.rightCellId === null ? null : cellById.get(edge.rightCellId);
    const isSea = Boolean(leftCell?.features.sea && rightCell?.features.sea);

    return {
      ...edge,
      features: {
        ...edge.features,
        sea: isSea,
      },
    };
  });

  return {
    ...map,
    cells,
    edges,
    water: {
      sides: activeSides,
      seaCellIds: Array.from(selected),
    },
  };
}

function isWithinWaterReach(cell, activeSides, size, maxWaterReach) {
  if (!activeSides.length) {
    return false;
  }

  const nearestWaterDistance = Math.min(...activeSides.map((side) => distanceToSide(cell.centroid, size, side)));
  return nearestWaterDistance <= maxWaterReach;
}

function pressureFromSides(cell, map) {
  const distances = map.init.params.waterSides
    .filter((side) => side.enabled)
    .map((side) => distanceToSide(cell.centroid, map.meta.size, side.name));

  if (!distances.length) {
    return 0;
  }

  const nearest = Math.min(...distances);
  return 1 - Math.min(nearest / (map.meta.size * PRESSURE_RANGE_RATIO), 1);
}
