/*
 * WHAT: Share segmented land-path search used by hover previews and river generation.
 * HOW: Build a real edge lookup, run shortest-cell BFS with segmented-length tiebreaks, and emit polyline points.
 * WHY: Step 5 previews and the committed first river must follow the exact same routing rules.
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

function findCenterSeaCellId(cells, size) {
  let bestCellId = null;
  let bestDistance = Infinity;

  cells.forEach((cell) => {
    if (!cell.features.sea) {
      return;
    }

    const dx = cell.centroid.x - size / 2;
    const dy = cell.centroid.y - size / 2;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCellId = cell.id;
    }
  });

  return bestCellId;
}

export function findCenterSeaLandPath(cells, edges, startCellId, size, startEntryPoint = null, minTurnAngleDegrees = 90) {
  const edgeLookup = buildEdgeLookup(edges);
  const centerSeaCellId = findCenterSeaCellId(cells, size);
  if (centerSeaCellId === null) {
    const westOutlet = findWestOutlet(cells, edges, size);
    if (!westOutlet) {
      return null;
    }

    return findBestShortestPath(cells, edgeLookup, startCellId, {
      isTarget: (cell) => cell.id === westOutlet.cellId,
      targetExitPoint: () => westOutlet.point,
      startEntryPoint,
      minTurnAngleDegrees,
    });
  }

  const targetCoastCellIds = new Set(
    cells
      .filter((cell) => cell.features.land && cell.neighborCellIds.some((neighborId) => neighborId === centerSeaCellId))
      .map((cell) => cell.id),
  );
  if (!targetCoastCellIds.size) {
    return null;
  }

  const coastData = buildCoastDistanceData(cells, edges);
  return findBestShortestPath(cells, edgeLookup, startCellId, {
    isTarget: (cell) => targetCoastCellIds.has(cell.id),
    targetExitPoint: (cell) => {
      const seaNeighborIds = cell.neighborCellIds.filter((neighborId) => cells[neighborId]?.features.sea);
      const coastEdge = seaNeighborIds
        .map((neighborId) => edgeLookup.get(edgeKey(cell.id, neighborId)))
        .find(Boolean);
      return coastEdge ? { x: coastEdge.midpoint.x, y: coastEdge.midpoint.y } : null;
    },
    coastData,
    startEntryPoint,
    minTurnAngleDegrees,
  });
}

export function findLandPathToTargets(cells, edges, startCellId, {
  isTarget,
  targetExitPoint,
  canTraverse,
  startEntryPoint = null,
  minTurnAngleDegrees = 90,
}) {
  const edgeLookup = buildEdgeLookup(edges);
  const hasSea = cells.some((cell) => cell.features.sea);
  return findBestShortestPath(cells, edgeLookup, startCellId, {
    isTarget,
    targetExitPoint,
    canTraverse,
    coastData: hasSea ? buildCoastDistanceData(cells, edges) : null,
    startEntryPoint,
    minTurnAngleDegrees,
  });
}

function findBestShortestPath(cells, edgeLookup, startCellId, {
  isTarget,
  targetExitPoint,
  canTraverse,
  coastData,
  startEntryPoint = null,
  minTurnAngleDegrees = 90,
}) {
  const startCell = cells.find((cell) => cell.id === startCellId);
  if (!startCell || !(canTraverse ? canTraverse(startCell, null) : defaultTraversable(startCell))) {
    return null;
  }

  const previousByCellId = new Map();
  let currentLevel = [startCellId];
  const visitedDepth = new Map([[startCellId, 0]]);
  const bestLengthByCellId = new Map([[startCellId, 0]]);

  for (let depth = 0; currentLevel.length > 0; depth += 1) {
    const nextLevel = [];
    const nextLevelSet = new Set();
    const candidateStates = new Map();

    for (const cellId of currentLevel) {
      const cell = cells[cellId];
      if (!cell) {
        continue;
      }

      for (const neighborId of cell.neighborCellIds) {
        const neighbor = cells[neighborId];
        if (!neighbor || !(canTraverse ? canTraverse(neighbor, cell) : defaultTraversable(neighbor))) {
          continue;
        }
        if (coastData && !canAdvanceTowardSea(cell, neighbor, isTarget, coastData)) {
          continue;
        }

        const seenDepth = visitedDepth.get(neighborId);
        if (seenDepth !== undefined && seenDepth < depth + 1) {
          continue;
        }

        const edge = edgeLookup.get(edgeKey(cellId, neighborId));
        if (!edge) {
          continue;
        }
        if (!allowsTurn(previousByCellId.get(cellId), cell, edge, edgeLookup, startEntryPoint, minTurnAngleDegrees)) {
          continue;
        }

        const candidateLength = (bestLengthByCellId.get(cellId) || 0) + segmentLengthThroughEdge(cell, neighbor, edge);
        const existingCandidate = candidateStates.get(neighborId);
        if (!existingCandidate || candidateLength > existingCandidate.length) {
          candidateStates.set(neighborId, {
            previousCellId: cellId,
            length: candidateLength,
          });
        }

        if (!nextLevelSet.has(neighborId) && seenDepth === undefined) {
          nextLevelSet.add(neighborId);
          nextLevel.push(neighborId);
        }
      }
    }

    if (candidateStates.size === 0) {
      return null;
    }

    candidateStates.forEach((candidate, cellId) => {
      visitedDepth.set(cellId, depth + 1);
      bestLengthByCellId.set(cellId, candidate.length);
      previousByCellId.set(cellId, candidate.previousCellId);
    });

    const targetCandidates = Array.from(candidateStates.entries())
      .filter(([cellId]) => isTarget(cells[cellId]))
      .map(([cellId, state]) => {
        const exitPoint = targetExitPoint?.(cells[cellId]) ?? null;
        if (!allowsExitTurn(state.previousCellId, cells[cellId], exitPoint, edgeLookup, startEntryPoint, minTurnAngleDegrees)) {
          return null;
        }
        return {
          cellId,
          state,
          exitPoint,
          totalLength: state.length + (exitPoint ? pointDistance(cells[cellId].centroid, exitPoint) : 0),
        };
      })
      .filter(Boolean)
      .sort((first, second) => second.totalLength - first.totalLength);
    if (targetCandidates.length) {
      const target = targetCandidates[0];
      return buildFlowPath(cells, edgeLookup, previousByCellId, startCellId, target.cellId, target.exitPoint);
    }

    currentLevel = nextLevel;
  }

  return null;
}

function buildFlowPath(cells, edgeLookup, previousByCellId, startCellId, endCellId, targetExitPoint = null) {
  const cellIds = [];
  let cursor = endCellId;

  while (cursor !== undefined) {
    cellIds.push(cursor);
    if (cursor === startCellId) {
      break;
    }
    cursor = previousByCellId.get(cursor);
  }

  if (cellIds[cellIds.length - 1] !== startCellId) {
    return null;
  }

  cellIds.reverse();
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

  if (targetExitPoint !== null) {
    points.push(targetExitPoint);
  }

  return {
    cellIds,
    points,
    length: pathLength(points),
  };
}

function edgeKey(firstCellId, secondCellId) {
  return firstCellId < secondCellId ? `${firstCellId}:${secondCellId}` : `${secondCellId}:${firstCellId}`;
}

function segmentLengthThroughEdge(firstCell, secondCell, edge) {
  return pointDistance(firstCell.centroid, edge.midpoint) + pointDistance(edge.midpoint, secondCell.centroid);
}

function pathLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += pointDistance(points[index - 1], points[index]);
  }
  return length;
}

function pointDistance(firstPoint, secondPoint) {
  return Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y);
}

function allowsTurn(previousCellId, currentCell, nextEdge, edgeLookup, startEntryPoint, minTurnAngleDegrees) {
  const incomingPoint = previousCellId === undefined
    ? startEntryPoint
    : getSharedEdgeMidpoint(previousCellId, currentCell.id, edgeLookup);
  if (!incomingPoint) {
    return true;
  }

  return angleDegreesBetween(incomingPoint, currentCell.centroid, nextEdge.midpoint) >= minTurnAngleDegrees;
}

function allowsExitTurn(previousCellId, currentCell, exitPoint, edgeLookup, startEntryPoint, minTurnAngleDegrees) {
  if (!exitPoint) {
    return true;
  }

  const incomingPoint = previousCellId === undefined
    ? startEntryPoint
    : getSharedEdgeMidpoint(previousCellId, currentCell.id, edgeLookup);
  if (!incomingPoint) {
    return true;
  }

  return angleDegreesBetween(incomingPoint, currentCell.centroid, exitPoint) >= minTurnAngleDegrees;
}

function getSharedEdgeMidpoint(firstCellId, secondCellId, edgeLookup) {
  const edge = edgeLookup.get(edgeKey(firstCellId, secondCellId));
  return edge ? edge.midpoint : null;
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

function defaultTraversable(cell) {
  return cell.features.land && !cell.features.hill && !cell.features.hillside;
}

function buildCoastDistanceData(cells, edges) {
  const coastPoints = edges
    .filter((edge) => {
      const leftCell = edge.leftCellId === null ? null : cells[edge.leftCellId];
      const rightCell = edge.rightCellId === null ? null : cells[edge.rightCellId];
      return Boolean(
        (leftCell?.features.land && rightCell?.features.sea)
        || (leftCell?.features.sea && rightCell?.features.land),
      );
    })
    .map((edge) => ({ x: edge.midpoint.x, y: edge.midpoint.y }));

  const coastalLandCellIds = new Set(
    cells
      .filter((cell) => cell.features.land && cell.neighborCellIds.some((neighborId) => cells[neighborId]?.features.sea))
      .map((cell) => cell.id),
  );

  const distanceByCellId = new Map(
    cells
      .filter((cell) => cell.features.land)
      .map((cell) => [cell.id, nearestPointDistance(cell.centroid, coastPoints)]),
  );

  return {
    coastalLandCellIds,
    distanceByCellId,
  };
}

function canAdvanceTowardSea(currentCell, neighborCell, isTarget, coastData) {
  if (coastData.coastalLandCellIds.has(neighborCell.id) && !isTarget(neighborCell)) {
    return false;
  }

  const currentDistance = coastData.distanceByCellId.get(currentCell.id);
  const nextDistance = coastData.distanceByCellId.get(neighborCell.id);
  if (!Number.isFinite(currentDistance) || !Number.isFinite(nextDistance)) {
    return false;
  }

  return nextDistance < currentDistance;
}

function nearestPointDistance(point, candidates) {
  if (!candidates.length) {
    return Infinity;
  }

  let nearest = Infinity;
  candidates.forEach((candidate) => {
    nearest = Math.min(nearest, pointDistance(point, candidate));
  });
  return nearest;
}

function findWestOutlet(cells, edges, size) {
  const westTarget = { x: 0, y: size / 2 };
  const westBoundaryEdges = edges.filter((edge) =>
    edge.features.boundary
    && Math.abs(edge.from.x) <= 2.25
    && Math.abs(edge.to.x) <= 2.25,
  );

  const candidates = westBoundaryEdges
    .map((edge) => {
      const cellId = edge.leftCellId ?? edge.rightCellId;
      const cell = cellId === null ? null : cells[cellId];
      if (!cell || !cell.features.land || cell.features.hill || cell.features.hillside) {
        return null;
      }

      return {
        cellId,
        point: { x: edge.midpoint.x, y: edge.midpoint.y },
        distance: pointDistance(edge.midpoint, westTarget),
      };
    })
    .filter(Boolean)
    .sort((first, second) => first.distance - second.distance || first.cellId - second.cellId);

  return candidates[0] || null;
}
