/*
 * WHAT: Commit one first river using the longest valid center-sea drainage path from a non-corner boundary cell.
 * HOW: Evaluate all eligible one-side boundary land cells with the shared center-sea path search, then keep the longest result.
 * WHY: The first river should feel like the dominant drainage line of the map rather than an arbitrary source.
 */

import { computeSeaDistances, findCenterSeaLandPath } from "../river-path.js";
import { attachRiverData, buildRiverLength, chooseRiverName, findSourceBoundaryMidpoint } from "../river-model.js";

const MIN_RIVER_SOURCE_SEA_DISTANCE = 3;

export function runFirstRiverStep(map, { rng }) {
  const river = chooseFirstRiver(map, rng);
  const nextMap = attachRiverData(map, {
    primary: river,
    secondary: null,
  });

  return {
    map: nextMap,
    frameEntries: [
      {
        label: river ? "Step 1.7 / Primary river" : "Step 1.7 / No river",
        map: nextMap,
      },
    ],
  };
}

function chooseFirstRiver(map, rng) {
  const minTurnAngleDegrees = map.init.params.riverTurnAngle ?? 90;
  const maxSeaDistance = map.init.params.maxSeaDistance ?? 50;
  const seaDistances = map.cells.some((cell) => cell.features.sea) ? computeSeaDistances(map.cells) : null;
  const eligibleCells = map.cells.filter((cell) =>
    cell.features.land
    && !cell.features.hill
    && !cell.features.hillside
    && cell.boundarySides.length === 1
    && (!seaDistances || (seaDistances[cell.id] >= MIN_RIVER_SOURCE_SEA_DISTANCE && seaDistances[cell.id] <= maxSeaDistance)),
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
          maxSeaDistance,
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
  const riverName = chooseRiverName(rng);
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
