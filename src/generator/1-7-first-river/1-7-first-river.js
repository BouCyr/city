/*
 * WHAT: Commit one primary river by selecting a valid mouth and tracing the longest inland route.
 * HOW: Build sea-distance gradients, evaluate central coast mouths, enumerate bounded inland paths, then keep the longest geometry.
 * WHY: Rivers should enter the sea at plausible mouths and grow inland from the coast.
 */

import {
  DEFAULT_RIVER_TURN_ANGLE_DEGREES,
  buildRiverPathPoints,
  computeSeaDistances,
  findInlandRiverPaths,
  findRiverMouthCandidates,
} from "../river-path.js";
import { attachRiverData, buildRiverLength, chooseRiverName, findSourceBoundaryMidpoint } from "../river-model.js";

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
  if (!map.cells.some((cell) => cell.features.sea)) {
    return null;
  }

  const seaDistances = computeSeaDistances(map.cells);
  const mouthCandidates = findRiverMouthCandidates(map);
  const candidates = mouthCandidates
    .flatMap((mouth) => {
      const paths = findInlandRiverPaths(map.cells, map.edges, seaDistances, mouth.landCellId, {
        minimumTurnAngleDegrees: map.init.params.primaryRiverTurnAngleDegrees ?? DEFAULT_RIVER_TURN_ANGLE_DEGREES,
      });
      return paths.map((path) => buildPrimaryCandidate(map, mouth, path));
    })
    .filter(Boolean)
    .sort(comparePrimaryCandidates);

  if (!candidates.length) {
    return null;
  }

  const selected = candidates[0];
  const riverName = chooseRiverName(rng);
  return {
    id: 0,
    name: riverName,
    sourceCellId: selected.sourceCellId,
    targetSeaCellId: selected.targetSeaCellId,
    cellIds: selected.cellIds,
    points: selected.points,
    length: selected.length,
    strokeWidth: map.init.params.primaryRiverWidth ?? 6,
    strokeWidthBeforeMerge: map.init.params.primaryRiverWidth ?? 6,
    strokeWidthAfterMerge: map.init.params.primaryRiverWidth ?? 6,
    widthMergeCellId: null,
  };
}

function buildPrimaryCandidate(map, mouth, mouthToBoundaryPath) {
  const sourceToMouthCellIds = [...mouthToBoundaryPath.cellIds].reverse();
  const sourceCell = map.cells[sourceToMouthCellIds[0]];
  if (!sourceCell) {
    return null;
  }

  const sourcePoint = findSourceBoundaryMidpoint(map, sourceCell);
  if (!sourcePoint) {
    return null;
  }

  const pathPoints = buildRiverPathPoints(map.cells, map.edges, sourceToMouthCellIds, mouth.mouthPoint);
  return {
    sourceCellId: sourceCell.id,
    targetSeaCellId: mouth.seaCellId,
    mouthLandCellId: mouth.landCellId,
    cellIds: sourceToMouthCellIds,
    points: [sourcePoint, ...pathPoints],
    length: buildRiverLength(sourcePoint, pathPoints),
  };
}

function comparePrimaryCandidates(first, second) {
  const lengthDelta = second.length - first.length;
  if (Math.abs(lengthDelta) > 0.001) {
    return lengthDelta;
  }

  return second.cellIds.length - first.cellIds.length
    || first.targetSeaCellId - second.targetSeaCellId
    || first.mouthLandCellId - second.mouthLandCellId
    || first.sourceCellId - second.sourceCellId;
}
