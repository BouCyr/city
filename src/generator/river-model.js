/*
 * WHAT: Share river naming, source-point lookup, length, and attachment helpers.
 * HOW: Export pure utilities used by primary and secondary river steps.
 * WHY: Step files should describe one transformation each, without duplicating river plumbing.
 */

export const RIVER_NAMES = [
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

export function chooseRiverName(rng, existingRivers = []) {
  const usedNames = new Set(existingRivers.map((river) => river.name));
  const availableNames = RIVER_NAMES.filter((name) => !usedNames.has(name));
  return rng.pick(availableNames.length ? availableNames : RIVER_NAMES);
}

export function attachRiverData(map, riverPatch) {
  const primary = riverPatch.primary ?? map.river?.primary ?? null;
  const secondary = riverPatch.secondary ?? map.river?.secondary ?? null;
  const rivers = [primary, secondary].filter(Boolean);
  const riverCellIds = new Set(rivers.flatMap((river) => river.cellIds));
  const cells = map.cells.map((cell) => ({
    ...cell,
    features: {
      ...cell.features,
      river: riverCellIds.has(cell.id),
    },
  }));

  return {
    ...map,
    cells,
    river: {
      primary,
      secondary,
    },
    rivers,
  };
}

export function findSourceBoundaryMidpoint(map, cell) {
  const boundaryEdges = map.edges.filter((edge) =>
    cell.edgeIds.includes(edge.id)
    && edge.features.boundary
    && [edge.leftCellId, edge.rightCellId].filter((cellId) => cellId === cell.id).length === 1,
  );

  if (!boundaryEdges.length) {
    return null;
  }

  const side = cell.boundarySides[0];
  const matchingEdge = boundaryEdges.find((edge) => edgeOnSide(edge, map.meta.size, side)) || boundaryEdges[0];
  return matchingEdge ? { x: matchingEdge.midpoint.x, y: matchingEdge.midpoint.y } : null;
}

export function buildRiverLength(sourcePoint, points) {
  let length = 0;
  let previousPoint = sourcePoint;
  points.forEach((point) => {
    length += Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y);
    previousPoint = point;
  });
  return length;
}

function edgeOnSide(edge, mapSize, side, epsilon = 2.25) {
  if (side === "north") {
    return Math.abs(edge.from.y) <= epsilon && Math.abs(edge.to.y) <= epsilon;
  }
  if (side === "south") {
    return Math.abs(edge.from.y - mapSize) <= epsilon && Math.abs(edge.to.y - mapSize) <= epsilon;
  }
  if (side === "west") {
    return Math.abs(edge.from.x) <= epsilon && Math.abs(edge.to.x) <= epsilon;
  }
  if (side === "east") {
    return Math.abs(edge.from.x - mapSize) <= epsilon && Math.abs(edge.to.x - mapSize) <= epsilon;
  }
  return false;
}
