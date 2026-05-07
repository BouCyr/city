/*
 * WHAT: Collapse very short cell-geometry edges after Lloyd relaxation.
 * HOW: Repeatedly merge the vertices of the current shortest edge below the lot segment length, then rebuild topology.
 * WHY: Downstream lots should not inherit tiny Voronoi edges that are shorter than the canonical segment size.
 */

import { clonePoint, midpointBetween, pointDistance } from "../map-model.js";
import { edgeKey, normalizeVertexRing, rebuildCellTopology } from "../cell-topology.js";

export function runCollapseShortEdgesStep(map) {
  const nextMap = collapseShortEdges(map, map.init?.params?.collapseShortEdgeLength ?? 35);

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

  return rebuildCellTopology(map, cells, vertexPoints, { edgeIdPrefix: "collapsed" });
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
