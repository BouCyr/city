/*
 * WHAT: Commit a single tributary that merges into the first river well upstream from the outlet.
 * HOW: Find merge-eligible cells on the existing river, then keep the longest valid boundary-source path that
 *      reaches a merge edge without crossing hill, hillside, or existing river cells.
 * WHY: Tributaries should read as distinct feeders rather than overlapping the main stem or merging too close to the sea.
 */

import { computeSeaDistances, findLandPathToTargets } from "./river-path.js";

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

export function runFirstTributaryStep(map, { rng }) {
  const tributary = chooseFirstTributary(map, rng);
  const rivers = tributary ? applyRiverWidths(map, map.rivers, tributary) : map.rivers;
  const nextMap = attachRiverData(map, rivers);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: tributary ? "Step 1.7 / First tributary" : "Step 1.7 / No tributary",
        map: nextMap,
      },
    ],
  };
}

function chooseFirstTributary(map, rng) {
  const primaryRiver = map.rivers[0];
  if (!primaryRiver) {
    return null;
  }
  const minTurnAngleDegrees = map.init.params.riverTurnAngle ?? 90;
  const primaryRiverWidth = map.init.params.primaryRiverWidth ?? 6;
  const tributaryWidthRatio = map.init.params.tributaryWidthRatio ?? 0.72;
  const minSourceRiverDistance = map.init.params.tributarySourceRiverDistance ?? 6;
  const minMergeSeaDistance = map.init.params.tributaryMergeSeaDistance ?? 5;
  const riverDistances = computeDistancesFromSources(map, primaryRiver.cellIds);

  const mergeTargets = buildMergeTargetMap(map, primaryRiver, minMergeSeaDistance, minTurnAngleDegrees);
  if (!mergeTargets.size) {
    return null;
  }

  const eligibleCells = map.cells.filter((cell) =>
    cell.features.land
    && !cell.features.hill
    && !cell.features.hillside
    && !cell.features.river
    && riverDistances[cell.id] >= minSourceRiverDistance
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
        ? findLandPathToTargets(map.cells, map.edges, candidate.cell.id, {
          isTarget: (targetCell) => mergeTargets.has(targetCell.id),
          targetExitPoint: (targetCell) => {
            const mergeInfo = mergeTargets.get(targetCell.id);
            if (!mergeInfo) {
              return null;
            }

            const mergeCell = map.cells[mergeInfo.mergeCellId];
            return mergeCell ? { x: mergeCell.centroid.x, y: mergeCell.centroid.y } : null;
          },
          canTraverse: (targetCell) =>
            targetCell.features.land
            && !targetCell.features.hill
            && !targetCell.features.hillside
            && !targetCell.features.river,
          startEntryPoint: candidate.sourcePoint,
          minTurnAngleDegrees,
        })
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
  const mergeInfo = mergeTargets.get(selected.path.cellIds[selected.path.cellIds.length - 1]);
  const pathPoints = mergeInfo
    ? [...selected.path.points.slice(0, -1), mergeInfo.point, selected.path.points[selected.path.points.length - 1]]
    : selected.path.points;
  const points = [selected.sourcePoint, ...pathPoints];
  return {
    id: map.rivers.length,
    name: chooseRiverName(rng, map.rivers),
    sourceCellId: selected.cell.id,
    mergedIntoRiverId: primaryRiver.id,
    mergeCellId: mergeInfo?.mergeCellId ?? null,
    cellIds: selected.path.cellIds,
    points,
    length: buildRiverLength(selected.sourcePoint, pathPoints),
    strokeWidth: primaryRiverWidth * tributaryWidthRatio,
  };
}

function buildMergeTargetMap(map, primaryRiver, minMergeSeaDistance, minTurnAngleDegrees) {
  const mergeTargets = new Map();
  const seaDistances = map.cells.some((cell) => cell.features.sea) ? computeSeaDistances(map.cells) : null;
  const validMergeCellIds = primaryRiver.cellIds.filter((cellId, index) => {
    if (seaDistances) {
      return seaDistances[cellId] >= minMergeSeaDistance;
    }

    return primaryRiver.cellIds.length - 1 - index >= minMergeSeaDistance;
  });

  validMergeCellIds.forEach((mergeCellId) => {
    const mergeCell = map.cells[mergeCellId];
    if (!mergeCell) {
      return;
    }

    mergeCell.neighborCellIds.forEach((neighborId) => {
      const neighbor = map.cells[neighborId];
      if (!neighbor || !neighbor.features.land || neighbor.features.hill || neighbor.features.hillside || neighbor.features.river) {
        return;
      }

      const sharedEdge = map.edges.find((edge) =>
        [edge.leftCellId, edge.rightCellId].includes(mergeCellId)
        && [edge.leftCellId, edge.rightCellId].includes(neighborId),
      );
      if (!sharedEdge) {
        return;
      }
      if (!isMergeAngleValid(map, primaryRiver, mergeCellId, sharedEdge.midpoint, minTurnAngleDegrees)) {
        return;
      }

      const existing = mergeTargets.get(neighborId);
      const candidate = {
        mergeCellId,
        point: { x: sharedEdge.midpoint.x, y: sharedEdge.midpoint.y },
      };
      if (!existing || mergeRank(primaryRiver, mergeCellId) > mergeRank(primaryRiver, existing.mergeCellId)) {
        mergeTargets.set(neighborId, candidate);
      }
    });
  });

  return mergeTargets;
}

function mergeRank(primaryRiver, mergeCellId) {
  const index = primaryRiver.cellIds.indexOf(mergeCellId);
  return primaryRiver.cellIds.length - index;
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

function chooseRiverName(rng, existingRivers) {
  const usedNames = new Set(existingRivers.map((river) => river.name));
  const availableNames = RIVER_NAMES.filter((name) => !usedNames.has(name));
  return rng.pick(availableNames.length ? availableNames : RIVER_NAMES);
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

function isMergeAngleValid(map, primaryRiver, mergeCellId, tributaryEntryPoint, minTurnAngleDegrees) {
  const mergeCellIndex = primaryRiver.cellIds.indexOf(mergeCellId);
  if (mergeCellIndex < 0 || mergeCellIndex >= primaryRiver.cellIds.length - 1) {
    return false;
  }

  const mergeCell = map.cells[mergeCellId];
  if (!mergeCell) {
    return false;
  }

  const downstreamCellId = primaryRiver.cellIds[mergeCellIndex + 1];
  const downstreamEdge = map.edges.find((edge) =>
    [edge.leftCellId, edge.rightCellId].includes(mergeCellId)
    && [edge.leftCellId, edge.rightCellId].includes(downstreamCellId),
  );
  if (!downstreamEdge) {
    return false;
  }

  return angleDegreesBetween(tributaryEntryPoint, mergeCell.centroid, downstreamEdge.midpoint) >= minTurnAngleDegrees;
}

function angleDegreesBetween(firstPoint, pivotPoint, secondPoint) {
  const firstVector = {
    x: firstPoint.x - pivotPoint.x,
    y: firstPoint.y - pivotPoint.y,
  };
  const secondVector = {
    x: secondPoint.x - pivotPoint.x,
    y: secondPoint.y - pivotPoint.y,
  };
  const firstLength = Math.hypot(firstVector.x, firstVector.y);
  const secondLength = Math.hypot(secondVector.x, secondVector.y);
  if (firstLength === 0 || secondLength === 0) {
    return 180;
  }

  const cosine = (
    (firstVector.x * secondVector.x) + (firstVector.y * secondVector.y)
  ) / (firstLength * secondLength);
  const clampedCosine = Math.min(1, Math.max(-1, cosine));
  return Math.acos(clampedCosine) * (180 / Math.PI);
}

function computeDistancesFromSources(map, sourceCellIds) {
  const distances = Array.from({ length: map.cells.length }, () => Infinity);
  const queue = [];

  sourceCellIds.forEach((cellId) => {
    distances[cellId] = 0;
    queue.push(cellId);
  });

  for (let index = 0; index < queue.length; index += 1) {
    const cellId = queue[index];
    const cell = map.cells[cellId];
    if (!cell) {
      continue;
    }

    cell.neighborCellIds.forEach((neighborId) => {
      if (distances[cellId] + 1 >= distances[neighborId]) {
        return;
      }

      distances[neighborId] = distances[cellId] + 1;
      queue.push(neighborId);
    });
  }

  return distances;
}
