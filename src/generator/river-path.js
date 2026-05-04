/*
 * WHAT: Share sea-distance river mouth selection and inland path enumeration.
 * HOW: Build coast mouth candidates, carry river drift state through bounded DFS, and emit centroid/edge-midpoint polylines.
 * WHY: Primary rivers, tributaries, and hover previews should follow the same deterministic routing rules.
 */

function buildEdgeLookup(edges) {
  const lookup = new Map();
  edges.forEach((edge) => {
    const adjacentCellIds = [edge.leftCellId, edge.rightCellId].filter((cellId) => cellId !== null);
    if (adjacentCellIds.length !== 2) {
      return;
    }

    lookup.set(edgeKey(adjacentCellIds[0], adjacentCellIds[1]), edge);
  });
  return lookup;
}

const CENTRAL_BOUNDARY_MIN_RATIO = 0.25;
const CENTRAL_BOUNDARY_MAX_RATIO = 0.75;
const MAX_RIVER_EXPANDED_STATES = 5000;
const MAX_RIVER_COMPLETED_PATHS = 500;
export const DEFAULT_RIVER_TURN_ANGLE_DEGREES = 30;

export function computeSeaDistances(cells) {
  const distances = Array.from({ length: cells.length }, () => Infinity);
  const queue = [];

  cells.forEach((cell) => {
    if (!cell.features.sea) {
      return;
    }

    distances[cell.id] = 0;
    queue.push(cell.id);
  });

  for (let index = 0; index < queue.length; index += 1) {
    const cellId = queue[index];
    const cell = cells[cellId];
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

export function findRiverMouthCandidates(map) {
  const boundarySides = activeWaterBoundarySides(map);
  const selectedSeaCellIds = new Set(
    map.cells
      .filter((cell) =>
        cell.features.sea
        && cell.neighborCellIds.filter((neighborId) => map.cells[neighborId]?.features.land).length > 1
        && isCentralBoundaryCell(cell, map.meta.size, boundarySides)
      )
      .map((cell) => cell.id),
  );
  const edgeLookup = buildEdgeLookup(map.edges);

  return map.cells
    .filter((cell) => {
      if (!cell.features.land) {
        return false;
      }

      const seaNeighborIds = cell.neighborCellIds.filter((neighborId) => map.cells[neighborId]?.features.sea);
      return seaNeighborIds.length === 1 && selectedSeaCellIds.has(seaNeighborIds[0]);
    })
    .map((cell) => {
      const seaCellId = cell.neighborCellIds.find((neighborId) => selectedSeaCellIds.has(neighborId));
      const coastEdge = edgeLookup.get(edgeKey(cell.id, seaCellId));
      return coastEdge
        ? {
          landCellId: cell.id,
          seaCellId,
          mouthPoint: { x: coastEdge.midpoint.x, y: coastEdge.midpoint.y },
        }
        : null;
    })
    .filter(Boolean)
    .sort((first, second) => first.seaCellId - second.seaCellId || first.landCellId - second.landCellId);
}

export function findInlandRiverPaths(cells, edges, seaDistances, startCellId, {
  blockedCellIds = new Set(),
  blockedAfterStartCellIds = blockedCellIds,
  blockedAfterFirstStepCellIds = new Set(),
  minimumTurnAngleDegrees = DEFAULT_RIVER_TURN_ANGLE_DEGREES,
  maxExpandedStates = MAX_RIVER_EXPANDED_STATES,
  maxCompletedPaths = MAX_RIVER_COMPLETED_PATHS,
} = {}) {
  const startCell = cells[startCellId];
  if (!startCell || !startCell.features.land || !Number.isFinite(seaDistances[startCellId])) {
    return [];
  }

  const completed = [];
  const edgeLookup = buildEdgeLookup(edges);
  const stack = [{
    cellIds: [startCellId],
    closerSteps: 0,
    sameDistanceSteps: 0,
    lastSegmentColor: null,
  }];
  let expandedStates = 0;

  while (stack.length && expandedStates < maxExpandedStates && completed.length < maxCompletedPaths) {
    const state = stack.pop();
    expandedStates += 1;

    const currentCellId = state.cellIds[state.cellIds.length - 1];
    const currentCell = cells[currentCellId];
    if (!currentCell) {
      continue;
    }

    if (state.cellIds.length > 1 && currentCell.boundarySides.length > 0) {
      completed.push({
        cellIds: [...state.cellIds],
      });
      continue;
    }

    const nextStates = currentCell.neighborCellIds
      .filter((neighborId) => canEnterRiverCell(cells, seaDistances, neighborId, state.cellIds, startCellId, blockedCellIds, blockedAfterStartCellIds, blockedAfterFirstStepCellIds))
      .filter((neighborId) => allowsRiverTurn(cells, edgeLookup, state.cellIds, neighborId, minimumTurnAngleDegrees))
      .map((neighborId) => buildNextRiverState(state, seaDistances[currentCellId], seaDistances[neighborId], neighborId))
      .filter(Boolean)
      .sort(compareRiverSearchStates);

    for (let index = nextStates.length - 1; index >= 0; index -= 1) {
      stack.push(nextStates[index]);
    }
  }

  return completed;
}

export function buildRiverPathPoints(cells, edges, cellIds, finalPoint = null) {
  const edgeLookup = buildEdgeLookup(edges);
  const points = [];

  cellIds.forEach((cellId, index) => {
    const cell = cells[cellId];
    if (!cell) {
      return;
    }

    points.push({ x: cell.centroid.x, y: cell.centroid.y });
    if (index >= cellIds.length - 1) {
      return;
    }

    const nextCellId = cellIds[index + 1];
    const edge = edgeLookup.get(edgeKey(cellId, nextCellId));
    if (edge) {
      points.push({ x: edge.midpoint.x, y: edge.midpoint.y });
    }
  });

  if (finalPoint) {
    points.push({ x: finalPoint.x, y: finalPoint.y });
  }

  return points;
}

function activeWaterBoundarySides(map) {
  const waterSides = map.water?.sides?.length
    ? map.water.sides
    : (map.init?.params?.waterSides || []).filter((side) => side.enabled).map((side) => side.name);
  return waterSides.length ? waterSides : ["north", "east", "south", "west"];
}

function isCentralBoundaryCell(cell, mapSize, boundarySides) {
  return boundarySides.some((side) => {
    const alongBoundaryRatio = side === "north" || side === "south"
      ? cell.centroid.x / mapSize
      : cell.centroid.y / mapSize;
    return alongBoundaryRatio >= CENTRAL_BOUNDARY_MIN_RATIO && alongBoundaryRatio <= CENTRAL_BOUNDARY_MAX_RATIO;
  });
}

function canEnterRiverCell(cells, seaDistances, cellId, currentPathCellIds, startCellId, blockedCellIds, blockedAfterStartCellIds, blockedAfterFirstStepCellIds) {
  const cell = cells[cellId];
  if (!cell || !cell.features.land || !Number.isFinite(seaDistances[cellId])) {
    return false;
  }
  if (currentPathCellIds.includes(cellId)) {
    return false;
  }
  if (cellId === startCellId) {
    return !blockedCellIds.has(cellId);
  }
  if (currentPathCellIds.length > 1 && blockedAfterFirstStepCellIds.has(cellId)) {
    return false;
  }
  if (currentPathCellIds.length > 1) {
    const previousCellId = currentPathCellIds[currentPathCellIds.length - 2];
    const previousCell = cells[previousCellId];
    if (previousCell?.neighborCellIds.includes(cellId)) {
      return false;
    }
  }
  return !blockedAfterStartCellIds.has(cellId);
}

function allowsRiverTurn(cells, edgeLookup, currentPathCellIds, nextCellId, minimumTurnAngleDegrees) {
  const currentCellId = currentPathCellIds[currentPathCellIds.length - 1];
  const currentCell = cells[currentCellId];
  const nextCell = cells[nextCellId];
  if (!currentCell || !nextCell) {
    return false;
  }

  const currentToNextEdge = edgeLookup.get(edgeKey(currentCellId, nextCellId));
  if (!currentToNextEdge) {
    return false;
  }

  if (currentPathCellIds.length >= 2) {
    const previousCellId = currentPathCellIds[currentPathCellIds.length - 2];
    const previousToCurrentEdge = edgeLookup.get(edgeKey(previousCellId, currentCellId));
    if (!previousToCurrentEdge) {
      return false;
    }

    if (
      angleDegreesBetween(previousToCurrentEdge.midpoint, currentCell.centroid, currentToNextEdge.midpoint) < minimumTurnAngleDegrees
    ) {
      return false;
    }
  }

  return angleDegreesBetween(currentCell.centroid, currentToNextEdge.midpoint, nextCell.centroid) >= minimumTurnAngleDegrees;
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
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * (180 / Math.PI);
}

function buildNextRiverState(state, currentSeaDistance, nextSeaDistance, nextCellId) {
  const nextSegmentColor = classifyRiverSegmentColor(currentSeaDistance, nextSeaDistance);
  if (state.lastSegmentColor === "red" && nextSegmentColor !== "green") {
    return null;
  }
  if (state.lastSegmentColor === "orange" && nextSegmentColor === "red") {
    return null;
  }

  if (currentSeaDistance <= 3 && nextSeaDistance <= currentSeaDistance) {
    return null;
  }

  if (nextSegmentColor === "green") {
    return {
      cellIds: [...state.cellIds, nextCellId],
      closerSteps: 0,
      sameDistanceSteps: 0,
      lastSegmentColor: nextSegmentColor,
    };
  }

  if (nextSegmentColor === "red") {
    if (state.closerSteps >= 1) {
      return null;
    }
    return {
      cellIds: [...state.cellIds, nextCellId],
      closerSteps: state.closerSteps + 1,
      sameDistanceSteps: state.sameDistanceSteps,
      lastSegmentColor: nextSegmentColor,
    };
  }

  if (state.sameDistanceSteps >= 2) {
    return null;
  }
  return {
    cellIds: [...state.cellIds, nextCellId],
    closerSteps: state.closerSteps,
    sameDistanceSteps: state.sameDistanceSteps + 1,
    lastSegmentColor: nextSegmentColor,
  };
}

function classifyRiverSegmentColor(currentSeaDistance, nextSeaDistance) {
  if (nextSeaDistance < currentSeaDistance) {
    return "red";
  }
  if (nextSeaDistance === currentSeaDistance) {
    return "orange";
  }
  return "green";
}

function compareRiverSearchStates(first, second) {
  const firstCellId = first.cellIds[first.cellIds.length - 1];
  const secondCellId = second.cellIds[second.cellIds.length - 1];
  return second.cellIds.length - first.cellIds.length || firstCellId - secondCellId;
}

function edgeKey(firstCellId, secondCellId) {
  return firstCellId < secondCellId ? `${firstCellId}:${secondCellId}` : `${secondCellId}:${firstCellId}`;
}
