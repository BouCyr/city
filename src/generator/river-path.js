/*
 * WHAT: Share segmented land-path search used by hover previews and river generation.
 * HOW: Build a real edge lookup, run shortest-cell BFS with segmented-length tiebreaks, and emit polyline points.
 * WHY: Step 5 previews and the committed first river must follow the exact same routing rules.
 */

export function buildEdgeLookup(edges) {
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

export function findCenterSeaCellId(cells, size) {
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

export function findCenterSeaLandPath(cells, edges, startCellId, size) {
  const startCell = cells.find((cell) => cell.id === startCellId);
  if (!startCell || !startCell.features.land || startCell.features.hill || startCell.features.hillside) {
    return null;
  }

  const centerSeaCellId = findCenterSeaCellId(cells, size);
  if (centerSeaCellId === null) {
    return null;
  }

  const targetCoastCellIds = new Set(
    cells
      .filter((cell) => cell.features.land && cell.neighborCellIds.some((neighborId) => neighborId === centerSeaCellId))
      .map((cell) => cell.id),
  );
  if (!targetCoastCellIds.size) {
    return null;
  }

  return findBestShortestPath(cells, buildEdgeLookup(edges), startCellId, {
    isTarget: (cell) => targetCoastCellIds.has(cell.id),
    targetSeaCellId: () => centerSeaCellId,
  });
}

export function findAnySeaLandPath(cells, edges, startCellId) {
  const startCell = cells.find((cell) => cell.id === startCellId);
  if (!startCell || !startCell.features.land || startCell.features.hill || startCell.features.hillside) {
    return null;
  }

  return findBestShortestPath(cells, buildEdgeLookup(edges), startCellId, {
    isTarget: (cell) => cell.features.land && cell.neighborCellIds.some((neighborId) => cells[neighborId]?.features.sea),
    targetSeaCellId: (cell) => {
      const seaNeighborIds = cell.neighborCellIds.filter((neighborId) => cells[neighborId]?.features.sea);
      return seaNeighborIds[0] ?? null;
    },
  });
}

function findBestShortestPath(cells, edgeLookup, startCellId, { isTarget, targetSeaCellId }) {
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
        if (!neighbor || !neighbor.features.land || neighbor.features.hill || neighbor.features.hillside) {
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
      .sort((first, second) => second[1].length - first[1].length);
    if (targetCandidates.length) {
      const endCellId = targetCandidates[0][0];
      return buildFlowPath(cells, edgeLookup, previousByCellId, startCellId, endCellId, targetSeaCellId?.(cells[endCellId]) ?? null);
    }

    currentLevel = nextLevel;
  }

  return null;
}

function buildFlowPath(cells, edgeLookup, previousByCellId, startCellId, endCellId, seaCellId = null) {
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

  if (seaCellId !== null) {
    const coastlineEdge = edgeLookup.get(edgeKey(endCellId, seaCellId));
    if (coastlineEdge) {
      points.push({ x: coastlineEdge.midpoint.x, y: coastlineEdge.midpoint.y });
    }
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
