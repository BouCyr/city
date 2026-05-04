/*
 * WHAT: Collapse very short cell-geometry edges after Lloyd relaxation.
 * HOW: Repeatedly merge the vertices of the current shortest edge below the lot segment length, then rebuild topology.
 * WHY: Downstream lots should not inherit tiny Voronoi edges that are shorter than the canonical segment size.
 */

import { DEFAULT_SEGMENT_LENGTH, clonePoint, midpointBetween, pointDistance } from "../map-model.js";
import { cross } from "../geometry.js";

export function runCollapseShortEdgesStep(map) {
  const nextMap = collapseShortEdges(map, DEFAULT_SEGMENT_LENGTH);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.4 / Collapsed edges",
        map: nextMap,
      },
    ],
  };
}

const EPSILON = 0.0001;
const MAX_COLLAPSE_PASSES = 20000;

function collapseShortEdges(map, minimumLength) {
  if (!Array.isArray(map.vertices) || !Array.isArray(map.cells) || !map.vertices.length || !map.cells.length) {
    return map;
  }

  const vertexPoints = new Map(map.vertices.map((vertex) => [vertex.id, clonePoint(vertex)]));
  let cells = map.cells.map((cell) => ({
    ...cell,
    vertexIds: normalizeVertexRing(cell.vertexIds || []),
  }));

  const protectedKeys = new Set();
  for (let pass = 0; pass < MAX_COLLAPSE_PASSES; pass += 1) {
    const candidate = findShortestEdgeCandidate(cells, vertexPoints, protectedKeys);
    if (!candidate || candidate.length >= minimumLength) {
      break;
    }

    const mergedCells = cells.map((cell) => ({
      ...cell,
      vertexIds: normalizeVertexRing(cell.vertexIds.map((vertexId) => vertexId === candidate.toVertexId ? candidate.fromVertexId : vertexId)),
    }));
    if (mergedCells.some((cell) => cell.vertexIds.length < 3)) {
      protectedKeys.add(candidate.key);
      continue;
    }

    vertexPoints.set(candidate.fromVertexId, mergeVertexPoints(candidate.from, candidate.to, map.meta.size));
    vertexPoints.delete(candidate.toVertexId);
    cells = mergedCells;
  }

  return rebuildCellTopology(map, cells, vertexPoints);
}

function findShortestEdgeCandidate(cells, vertexPoints, protectedKeys) {
  const candidates = new Map();

  cells.forEach((cell) => {
    const vertexIds = cell.vertexIds || [];
    for (let index = 0; index < vertexIds.length; index += 1) {
      const firstId = vertexIds[index];
      const secondId = vertexIds[(index + 1) % vertexIds.length];
      if (firstId === secondId) {
        continue;
      }

      const key = edgeKey(firstId, secondId);
      if (protectedKeys.has(key) || candidates.has(key)) {
        continue;
      }

      const first = vertexPoints.get(firstId);
      const second = vertexPoints.get(secondId);
      if (!first || !second) {
        continue;
      }

      candidates.set(key, {
        key,
        fromVertexId: Math.min(firstId, secondId),
        toVertexId: Math.max(firstId, secondId),
        from: clonePoint(vertexPoints.get(Math.min(firstId, secondId))),
        to: clonePoint(vertexPoints.get(Math.max(firstId, secondId))),
        length: pointDistance(first, second),
      });
    }
  });

  return Array.from(candidates.values()).sort((first, second) => {
    if (Math.abs(first.length - second.length) > EPSILON) {
      return first.length - second.length;
    }
    return first.key.localeCompare(second.key);
  })[0] || null;
}

function rebuildCellTopology(map, sourceCells, vertexPoints) {
  const usedOldVertexIds = [];
  const seenOldVertexIds = new Set();
  sourceCells.forEach((cell) => {
    cell.vertexIds.forEach((vertexId) => {
      if (!seenOldVertexIds.has(vertexId) && vertexPoints.has(vertexId)) {
        seenOldVertexIds.add(vertexId);
        usedOldVertexIds.push(vertexId);
      }
    });
  });

  const newVertexIdByOldId = new Map();
  const vertices = usedOldVertexIds.map((oldId, index) => {
    newVertexIdByOldId.set(oldId, index);
    const point = vertexPoints.get(oldId);
    return {
      id: index,
      x: point.x,
      y: point.y,
      edgeIds: [],
    };
  });

  const cells = sourceCells.map((cell) => {
    const vertexIds = normalizeVertexRing(cell.vertexIds.map((vertexId) => newVertexIdByOldId.get(vertexId)).filter((vertexId) => vertexId !== undefined));
    const polygon = vertexIds.map((vertexId) => clonePoint(vertices[vertexId]));
    return {
      ...cell,
      polygon,
      vertexIds,
      centroid: computePolygonCentroid(polygon),
      edgeIds: [],
      neighborCellIds: [],
    };
  });

  const edgeRecords = buildEdgeRecords(cells);
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const edges = edgeRecords.map((record, index) => {
    const id = `collapsed:${index}`;
    const oriented = orientCollapsedEdge(id, record, cells, vertices, map.meta.size);
    vertices[oriented.fromVertexId]?.edgeIds.push(id);
    vertices[oriented.toVertexId]?.edgeIds.push(id);
    record.cellIds.forEach((cellId) => {
      cellById.get(cellId)?.edgeIds.push(id);
    });
    return oriented;
  });

  edges.forEach((edge) => {
    if (edge.leftCellId === null || edge.rightCellId === null || edge.leftCellId === edge.rightCellId) {
      return;
    }

    const leftCell = cellById.get(edge.leftCellId);
    const rightCell = cellById.get(edge.rightCellId);
    if (leftCell && !leftCell.neighborCellIds.includes(edge.rightCellId)) {
      leftCell.neighborCellIds.push(edge.rightCellId);
    }
    if (rightCell && !rightCell.neighborCellIds.includes(edge.leftCellId)) {
      rightCell.neighborCellIds.push(edge.leftCellId);
    }
  });

  cells.forEach((cell) => {
    cell.edgeIds.sort((first, second) => String(first).localeCompare(String(second)));
    cell.neighborCellIds.sort((first, second) => first - second);
  });

  return {
    ...map,
    vertices,
    cells,
    edges,
    rivers: [],
    river: {
      primary: null,
      secondary: null,
    },
  };
}

function buildEdgeRecords(cells) {
  const recordsByKey = new Map();
  cells.forEach((cell) => {
    for (let index = 0; index < cell.vertexIds.length; index += 1) {
      const firstId = cell.vertexIds[index];
      const secondId = cell.vertexIds[(index + 1) % cell.vertexIds.length];
      if (firstId === secondId) {
        continue;
      }

      const key = edgeKey(firstId, secondId);
      const record = recordsByKey.get(key) || {
        key,
        firstId: Math.min(firstId, secondId),
        secondId: Math.max(firstId, secondId),
        cellIds: [],
      };
      if (!record.cellIds.includes(cell.id)) {
        record.cellIds.push(cell.id);
      }
      recordsByKey.set(key, record);
    }
  });

  return Array.from(recordsByKey.values()).sort((first, second) => first.key.localeCompare(second.key));
}

function orientCollapsedEdge(id, record, cells, vertices, mapSize) {
  const from = clonePoint(vertices[record.firstId]);
  const to = clonePoint(vertices[record.secondId]);
  const midpoint = midpointBetween(from, to);
  const cellIds = record.cellIds.slice(0, 2);
  const isBoundary = cellIds.length < 2 || liesOnCanvasBoundary(from, to, mapSize);

  if (cellIds.length === 1) {
    const cellId = cellIds[0];
    const side = pointSide(from, to, cells[cellId]?.centroid);
    return buildEdge({
      id,
      fromVertexId: record.firstId,
      toVertexId: record.secondId,
      from,
      to,
      midpoint,
      leftCellId: side >= 0 ? cellId : null,
      rightCellId: side < 0 ? cellId : null,
      boundary: isBoundary,
      cells,
    });
  }

  const [firstCellId, secondCellId] = cellIds;
  const firstSide = pointSide(from, to, cells[firstCellId]?.centroid);
  const secondSide = pointSide(from, to, cells[secondCellId]?.centroid);
  return buildEdge({
    id,
    fromVertexId: record.firstId,
    toVertexId: record.secondId,
    from,
    to,
    midpoint,
    leftCellId: firstSide >= secondSide ? firstCellId : secondCellId,
    rightCellId: firstSide >= secondSide ? secondCellId : firstCellId,
    boundary: isBoundary,
    cells,
  });
}

function buildEdge({ id, fromVertexId, toVertexId, from, to, midpoint, leftCellId, rightCellId, boundary, cells }) {
  const leftCell = leftCellId === null ? null : cells[leftCellId];
  const rightCell = rightCellId === null ? null : cells[rightCellId];
  return {
    id,
    fromVertexId,
    toVertexId,
    from,
    to,
    midpoint,
    leftCellId,
    rightCellId,
    features: {
      boundary,
      sea: Boolean(leftCell?.features.sea && rightCell?.features.sea),
      river: false,
    },
  };
}

function normalizeVertexRing(vertexIds) {
  const normalized = [];
  vertexIds.forEach((vertexId) => {
    const previous = normalized[normalized.length - 1];
    if (vertexId !== undefined && vertexId !== previous) {
      normalized.push(vertexId);
    }
  });

  if (normalized.length > 1 && normalized[0] === normalized[normalized.length - 1]) {
    normalized.pop();
  }

  return normalized;
}

function computePolygonCentroid(polygon) {
  if (!polygon.length) {
    return { x: 0, y: 0 };
  }

  let areaTwice = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const factor = current.x * next.y - next.x * current.y;
    areaTwice += factor;
    centroidX += (current.x + next.x) * factor;
    centroidY += (current.y + next.y) * factor;
  }

  if (Math.abs(areaTwice) < EPSILON) {
    return {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
  }

  return {
    x: centroidX / (3 * areaTwice),
    y: centroidY / (3 * areaTwice),
  };
}

function pointSide(from, to, point) {
  if (!point) {
    return 0;
  }

  return cross(
    {
      x: to.x - from.x,
      y: to.y - from.y,
    },
    {
      x: point.x - from.x,
      y: point.y - from.y,
    },
  );
}

function mergeVertexPoints(first, second, size) {
  const merged = midpointBetween(first, second);
  const firstBoundarySides = boundarySidesForPoint(first, size);
  const secondBoundarySides = boundarySidesForPoint(second, size);
  const boundarySides = [...new Set([...firstBoundarySides, ...secondBoundarySides])];
  if (!boundarySides.length) {
    return merged;
  }

  if (boundarySides.includes("west")) {
    merged.x = 0;
  } else if (boundarySides.includes("east")) {
    merged.x = size;
  } else {
    merged.x = clampToMap(merged.x, size);
  }

  if (boundarySides.includes("north")) {
    merged.y = 0;
  } else if (boundarySides.includes("south")) {
    merged.y = size;
  } else {
    merged.y = clampToMap(merged.y, size);
  }

  return merged;
}

function boundarySidesForPoint(point, size, epsilon = 2.25) {
  const sides = [];
  if (Math.abs(point.x) <= epsilon) {
    sides.push("west");
  }
  if (Math.abs(point.x - size) <= epsilon) {
    sides.push("east");
  }
  if (Math.abs(point.y) <= epsilon) {
    sides.push("north");
  }
  if (Math.abs(point.y - size) <= epsilon) {
    sides.push("south");
  }
  return sides;
}

function clampToMap(value, size) {
  return Math.min(size, Math.max(0, value));
}

function liesOnCanvasBoundary(from, to, size, epsilon = 2.25) {
  return (
    (Math.abs(from.x) <= epsilon && Math.abs(to.x) <= epsilon)
    || (Math.abs(from.x - size) <= epsilon && Math.abs(to.x - size) <= epsilon)
    || (Math.abs(from.y) <= epsilon && Math.abs(to.y) <= epsilon)
    || (Math.abs(from.y - size) <= epsilon && Math.abs(to.y - size) <= epsilon)
  );
}

function edgeKey(firstId, secondId) {
  return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
}
