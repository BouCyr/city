/*
 * WHAT: Commit one first river using the longest valid center-sea drainage path from a non-corner boundary cell.
 * HOW: Evaluate all eligible one-side boundary land cells with the shared center-sea path search, then keep the longest result.
 * WHY: The first river should feel like the dominant drainage line of the map rather than an arbitrary source.
 */

import { findCenterSeaLandPath } from "./river-path.js";

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

export function runFirstRiverStep(map, { rng }) {
  const river = chooseFirstRiver(map, rng);
  const nextMap = attachRiverData(map, river ? [river] : []);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: river ? "Step 6 / First river" : "Step 6 / No river",
        map: nextMap,
      },
    ],
  };
}

function chooseFirstRiver(map, rng) {
  const minTurnAngleDegrees = map.init.params.riverTurnAngle ?? 90;
  const eligibleCells = map.cells.filter((cell) =>
    cell.features.land
    && !cell.features.hill
    && !cell.features.hillside
    && cell.boundarySides.length === 1,
  );

  const candidates = eligibleCells
    .map((cell) => ({
      cell,
      sourcePoint: findSourceBoundaryMidpoint(map, cell),
    }))
    .map((candidate) => ({
      ...candidate,
      path: candidate.sourcePoint
        ? findCenterSeaLandPath(
          map.cells,
          map.edges,
          candidate.cell.id,
          map.meta.size,
          candidate.sourcePoint,
          minTurnAngleDegrees,
        )
        : null,
    }))
    .filter((candidate) => candidate.path && candidate.path.points.length >= 2 && candidate.sourcePoint)
    .sort((first, second) => {
      const stepDelta = second.path.cellIds.length - first.path.cellIds.length;
      if (stepDelta !== 0) {
        return stepDelta;
      }

      const lengthDelta = buildRiverLength(second.sourcePoint, second.path.points) - buildRiverLength(first.sourcePoint, first.path.points);
      if (Math.abs(lengthDelta) > 0.001) {
        return lengthDelta;
      }

      return first.cell.id - second.cell.id;
    });

  if (!candidates.length) {
    return null;
  }

  const selected = candidates[0];
  const riverName = rng.pick(RIVER_NAMES);
  const points = [selected.sourcePoint, ...selected.path.points];
  return {
    id: 0,
    name: riverName,
    sourceCellId: selected.cell.id,
    targetSeaCellId: inferTargetSeaCellId(map.cells, selected.path),
    cellIds: selected.path.cellIds,
    points,
    length: buildRiverLength(selected.sourcePoint, selected.path.points),
    strokeWidth: map.init.params.primaryRiverWidth ?? 6,
    strokeWidthBeforeMerge: map.init.params.primaryRiverWidth ?? 6,
    strokeWidthAfterMerge: map.init.params.primaryRiverWidth ?? 6,
    widthMergeCellId: null,
  };
}

function inferTargetSeaCellId(cells, path) {
  const endCellId = path.cellIds[path.cellIds.length - 1];
  const endCell = cells[endCellId];
  if (!endCell) {
    return null;
  }

  return endCell.neighborCellIds.find((neighborId) => cells[neighborId]?.features.sea) ?? null;
}

function attachRiverData(map, rivers) {
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
    rivers,
  };
}

function findSourceBoundaryMidpoint(map, cell) {
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

function edgeOnSide(edge, mapSize, side, epsilon = 0.75) {
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

function buildRiverLength(sourcePoint, points) {
  let length = 0;
  let previousPoint = sourcePoint;
  points.forEach((point) => {
    length += Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y);
    previousPoint = point;
  });
  return length;
}
