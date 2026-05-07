/*
 * WHAT: Rebuild canonical cell vertices, edges, and adjacency from edited cell vertex rings.
 * HOW: Normalize vertex ids, recompute polygons/centroids, orient shared edges, and refresh references.
 * WHY: Cell-geometry mutation steps need one topology rebuild path so downstream steps see the same shape.
 */

import { cross } from "./geometry.js";
import { clonePoint, midpointBetween } from "./map-model.js";

const EPSILON = 0.0001;

export function rebuildCellTopology(map, sourceCells, vertexPoints, { edgeIdPrefix = "cell" } = {}) {
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
    const id = `${edgeIdPrefix}:${index}`;
    const oriented = orientCellEdge(id, record, cells, vertices, map.meta.size);
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

export function normalizeVertexRing(vertexIds) {
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

export function computePolygonArea(polygon) {
  return Math.abs(computeSignedArea(polygon));
}

export function computePolygonCentroid(polygon) {
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

export function edgeKey(firstId, secondId) {
  return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
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

function orientCellEdge(id, record, cells, vertices, mapSize) {
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

function computeSignedArea(polygon) {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

function liesOnCanvasBoundary(from, to, size, epsilon = 2.25) {
  return (
    (Math.abs(from.x) <= epsilon && Math.abs(to.x) <= epsilon)
    || (Math.abs(from.x - size) <= epsilon && Math.abs(to.x - size) <= epsilon)
    || (Math.abs(from.y) <= epsilon && Math.abs(to.y) <= epsilon)
    || (Math.abs(from.y - size) <= epsilon && Math.abs(to.y - size) <= epsilon)
  );
}
