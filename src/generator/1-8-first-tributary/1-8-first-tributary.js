/*
 * WHAT: Commit a single tributary that grows from the primary river to a distant land boundary.
 * HOW: Enumerate bounded inland paths from merge-eligible primary cells, then score by branch length plus endpoint separation.
 * WHY: Tributaries should read as long feeders that join the main stem away from the sea.
 */

import { buildRiverPathPoints, computeSeaDistances, findInlandRiverPaths } from "../river-path.js";
import { attachRiverData, buildRiverLength, chooseRiverName, findSourceBoundaryMidpoint } from "../river-model.js";

const MIN_TRIBUTARY_MERGE_SEA_DISTANCE = 5;

export function runFirstTributaryStep(map, { rng }) {
  const tributary = chooseFirstTributary(map, rng);
  const rivers = tributary ? applyRiverWidths(map, map.rivers, tributary) : map.rivers;
  const nextMap = attachRiverData(map, {
    primary: rivers[0] ?? null,
    secondary: rivers[1] ?? null,
  });

  return {
    map: nextMap,
    frameEntries: [
      {
        label: tributary ? "Step 1.8 / River branch" : "Step 1.8 / No tributary",
        map: nextMap,
      },
    ],
  };
}

function chooseFirstTributary(map, rng) {
  const primaryRiver = map.rivers[0];
  if (!primaryRiver || !map.cells.some((cell) => cell.features.sea)) {
    return null;
  }

  const primaryRiverWidth = map.init.params.primaryRiverWidth ?? 6;
  const tributaryWidthRatio = map.init.params.tributaryWidthRatio ?? 0.72;

  const seaDistances = computeSeaDistances(map.cells);
  const primaryCellIds = new Set(primaryRiver.cellIds);
  const primaryNeighborCellIds = buildPrimaryNeighborCellIdSet(map.cells, primaryCellIds);
  const primarySourcePoint = primaryRiver.points?.[0] ?? map.cells[primaryRiver.sourceCellId]?.centroid ?? null;
  const candidates = primaryRiver.cellIds
    .filter((cellId) => seaDistances[cellId] >= MIN_TRIBUTARY_MERGE_SEA_DISTANCE)
    .flatMap((mergeCellId) => {
      const paths = findInlandRiverPaths(map.cells, map.edges, seaDistances, mergeCellId, {
        blockedAfterStartCellIds: primaryCellIds,
        blockedAfterFirstStepCellIds: primaryNeighborCellIds,
      });
      return paths.map((path) => buildTributaryCandidate(map, primaryRiver, primarySourcePoint, mergeCellId, path));
    })
    .filter(Boolean)
    .sort(compareTributaryCandidates);

  if (!candidates.length) {
    return null;
  }

  const selected = candidates[0];
  return {
    id: map.rivers.length,
    name: chooseRiverName(rng, map.rivers),
    sourceCellId: selected.sourceCellId,
    mergedIntoRiverId: primaryRiver.id,
    mergeCellId: selected.mergeCellId,
    cellIds: selected.cellIds,
    points: selected.points,
    length: selected.length,
    strokeWidth: primaryRiverWidth * tributaryWidthRatio,
  };
}

function buildPrimaryNeighborCellIdSet(cells, primaryCellIds) {
  const neighborCellIds = new Set();
  primaryCellIds.forEach((cellId) => {
    const cell = cells[cellId];
    if (!cell) {
      return;
    }

    cell.neighborCellIds.forEach((neighborId) => {
      if (!primaryCellIds.has(neighborId)) {
        neighborCellIds.add(neighborId);
      }
    });
  });
  return neighborCellIds;
}

function buildTributaryCandidate(map, primaryRiver, primarySourcePoint, mergeCellId, mergeToBoundaryPath) {
  const sourceToMergeCellIds = [...mergeToBoundaryPath.cellIds].reverse();
  const sourceCell = map.cells[sourceToMergeCellIds[0]];
  if (!sourceCell || sourceCell.id === mergeCellId) {
    return null;
  }

  const sourcePoint = findSourceBoundaryMidpoint(map, sourceCell);
  if (!sourcePoint) {
    return null;
  }

  const pathPoints = buildRiverPathPoints(map.cells, map.edges, sourceToMergeCellIds);
  const length = buildRiverLength(sourcePoint, pathPoints);
  const endpointDistance = primarySourcePoint ? pointDistance(sourcePoint, primarySourcePoint) : 0;
  return {
    sourceCellId: sourceCell.id,
    mergeCellId,
    cellIds: sourceToMergeCellIds,
    points: [sourcePoint, ...pathPoints],
    length,
    endpointDistance,
    score: length + endpointDistance,
    primaryRiverId: primaryRiver.id,
  };
}

function applyRiverWidths(map, rivers, tributary) {
  const primaryMergeWidthGain = map.init.params.primaryMergeWidthGain ?? 1.2;
  const updatedPrimary = rivers.map((river) => {
    if (river.id !== tributary.mergedIntoRiverId) {
      return river;
    }

    const baseWidth = river.strokeWidth ?? map.init.params.primaryRiverWidth ?? 6;
    return {
      ...river,
      strokeWidth: baseWidth,
      strokeWidthBeforeMerge: baseWidth,
      strokeWidthAfterMerge: baseWidth + primaryMergeWidthGain,
      widthMergeCellId: tributary.mergeCellId,
    };
  });

  return [...updatedPrimary, tributary];
}

function compareTributaryCandidates(first, second) {
  const scoreDelta = second.score - first.score;
  if (Math.abs(scoreDelta) > 0.001) {
    return scoreDelta;
  }

  const lengthDelta = second.length - first.length;
  if (Math.abs(lengthDelta) > 0.001) {
    return lengthDelta;
  }

  const endpointDelta = second.endpointDistance - first.endpointDistance;
  if (Math.abs(endpointDelta) > 0.001) {
    return endpointDelta;
  }

  return first.mergeCellId - second.mergeCellId || first.sourceCellId - second.sourceCellId;
}

function pointDistance(firstPoint, secondPoint) {
  return Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y);
}

