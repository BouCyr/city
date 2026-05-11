/*
 * WHAT: Add deterministic midpoint noise to long coast and land cell edges after sea classification.
 * HOW: Shuffle eligible edges, insert one displaced midpoint per edge, and track area deltas per adjacent cell.
 * WHY: Natural boundaries should be less rectilinear before rivers and lot geometry consume the cell topology.
 */

import { clonePoint, midpointBetween, pointDistance } from "../map-model.js";
import {
  computePolygonArea,
  computePolygonCentroid,
  normalizeVertexRing,
  rebuildCellTopology,
} from "../cell-topology.js";

const MIN_NOISE_EDGE_LENGTH = 100;
const DEFAULT_MIN_DISPLACEMENT_RATIO = 0.1;
const DEFAULT_MAX_DISPLACEMENT_RATIO = 0.2;
const EPSILON = 0.0001;

export function runNoiseStep(map, { rng }) {
  const result = applyCellEdgeNoise(map, rng, getNoiseOptions(map));
  const nextMap = result.map;

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.6 / Noise",
        map: nextMap,
      },
    ],
  };
}

function getNoiseOptions(map) {
  const minRatio = normalizeDisplacementRatio(map.init?.params?.noiseMinDisplacementRatio, DEFAULT_MIN_DISPLACEMENT_RATIO);
  const maxRatio = normalizeDisplacementRatio(map.init?.params?.noiseMaxDisplacementRatio, DEFAULT_MAX_DISPLACEMENT_RATIO);
  return {
    minDisplacementRatio: Math.min(minRatio, maxRatio),
    maxDisplacementRatio: Math.max(minRatio, maxRatio),
  };
}

function normalizeDisplacementRatio(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.min(0.5, value)) : fallback;
}

function applyCellEdgeNoise(map, rng, options) {
  if (!Array.isArray(map.vertices) || !Array.isArray(map.cells) || !Array.isArray(map.edges) || !map.cells.length) {
    return {
      map,
      splitCount: 0,
    };
  }

  const vertexPoints = new Map(map.vertices.map((vertex) => [vertex.id, clonePoint(vertex)]));
  const cells = map.cells.map((cell) => {
    const vertexIds = normalizeVertexRing(cell.vertexIds || []);
    const polygon = vertexIds.map((vertexId) => clonePoint(vertexPoints.get(vertexId))).filter(Boolean);
    return {
      ...cell,
      vertexIds,
      polygon,
      centroid: computePolygonCentroid(polygon),
    };
  });
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const areaDeltaByCellId = new Map(cells.map((cell) => [cell.id, 0]));
  const areaByCellId = new Map(cells.map((cell) => [cell.id, computePolygonArea(cell.polygon || [])]));
  const candidates = shuffleCandidates(buildNoiseCandidates(map, cellById), rng);
  let nextVertexId = Math.max(-1, ...map.vertices.map((vertex) => vertex.id)) + 1;
  let splitCount = 0;

  candidates.forEach((candidate) => {
    const leftCell = cellById.get(candidate.leftCellId);
    const rightCell = cellById.get(candidate.rightCellId);
    if (!leftCell || !rightCell) {
      return;
    }

    const leftEdgeIndex = findRingEdgeIndex(leftCell.vertexIds, candidate.fromVertexId, candidate.toVertexId);
    const rightEdgeIndex = findRingEdgeIndex(rightCell.vertexIds, candidate.fromVertexId, candidate.toVertexId);
    if (leftEdgeIndex < 0 || rightEdgeIndex < 0) {
      return;
    }

    const midpoint = midpointBetween(candidate.from, candidate.to);
    const targetCell = chooseTargetCell(leftCell, rightCell, areaDeltaByCellId, areaByCellId, rng);
    const displacedPoint = displaceToward(midpoint, targetCell.centroid, candidate.length, rng, options);
    const newVertexId = nextVertexId;
    vertexPoints.set(newVertexId, displacedPoint);

    const oldLeftArea = areaByCellId.get(leftCell.id) || 0;
    const oldRightArea = areaByCellId.get(rightCell.id) || 0;
    const previousLeftVertexIds = leftCell.vertexIds;
    const previousRightVertexIds = rightCell.vertexIds;
    leftCell.vertexIds = insertVertexAfterEdge(leftCell.vertexIds, leftEdgeIndex, newVertexId);
    rightCell.vertexIds = insertVertexAfterEdge(rightCell.vertexIds, rightEdgeIndex, newVertexId);
    updateCellGeometry(leftCell, vertexPoints);
    updateCellGeometry(rightCell, vertexPoints);

    const newLeftArea = computePolygonArea(leftCell.polygon || []);
    const newRightArea = computePolygonArea(rightCell.polygon || []);
    if (leftCell.vertexIds.length < 3 || rightCell.vertexIds.length < 3 || newLeftArea <= EPSILON || newRightArea <= EPSILON) {
      leftCell.vertexIds = previousLeftVertexIds;
      rightCell.vertexIds = previousRightVertexIds;
      updateCellGeometry(leftCell, vertexPoints);
      updateCellGeometry(rightCell, vertexPoints);
      vertexPoints.delete(newVertexId);
      return;
    }

    nextVertexId += 1;
    splitCount += 1;
    areaByCellId.set(leftCell.id, newLeftArea);
    areaByCellId.set(rightCell.id, newRightArea);
    areaDeltaByCellId.set(leftCell.id, (areaDeltaByCellId.get(leftCell.id) || 0) + newLeftArea - oldLeftArea);
    areaDeltaByCellId.set(rightCell.id, (areaDeltaByCellId.get(rightCell.id) || 0) + newRightArea - oldRightArea);
  });

  const rebuilt = rebuildCellTopology(map, cells, vertexPoints, { edgeIdPrefix: "noise" });
  return {
    map: {
      ...rebuilt,
      noise: {
        splitCount,
        minimumEdgeLength: MIN_NOISE_EDGE_LENGTH,
        displacementRatioRange: [options.minDisplacementRatio, options.maxDisplacementRatio],
        areaDeltaByCellId: Object.fromEntries(
          Array.from(areaDeltaByCellId.entries())
            .filter(([, delta]) => Math.abs(delta) > EPSILON)
            .map(([cellId, delta]) => [cellId, delta]),
        ),
      },
    },
    splitCount,
  };
}

function buildNoiseCandidates(map, cellById) {
  return map.edges
    .filter((edge) => {
      if (edge.features?.boundary || edge.leftCellId === null || edge.rightCellId === null) {
        return false;
      }
      if (edge.length !== undefined && edge.length <= MIN_NOISE_EDGE_LENGTH) {
        return false;
      }
      const length = pointDistance(edge.from, edge.to);
      if (length <= MIN_NOISE_EDGE_LENGTH) {
        return false;
      }
      const leftCell = cellById.get(edge.leftCellId);
      const rightCell = cellById.get(edge.rightCellId);
      if (!leftCell || !rightCell) {
        return false;
      }
      const leftSea = Boolean(leftCell.features?.sea);
      const rightSea = Boolean(rightCell.features?.sea);
      return leftSea !== rightSea || (!leftSea && !rightSea);
    })
    .map((edge) => ({
      id: edge.id,
      fromVertexId: edge.fromVertexId,
      toVertexId: edge.toVertexId,
      from: clonePoint(edge.from),
      to: clonePoint(edge.to),
      leftCellId: edge.leftCellId,
      rightCellId: edge.rightCellId,
      length: pointDistance(edge.from, edge.to),
    }));
}

function shuffleCandidates(candidates, rng) {
  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng.next() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function chooseTargetCell(leftCell, rightCell, areaDeltaByCellId, areaByCellId, rng) {
  const leftDelta = areaDeltaByCellId.get(leftCell.id) || 0;
  const rightDelta = areaDeltaByCellId.get(rightCell.id) || 0;
  if (Math.abs(leftDelta - rightDelta) > EPSILON) {
    return leftDelta < rightDelta ? rightCell : leftCell;
  }

  const leftArea = areaByCellId.get(leftCell.id) || 0;
  const rightArea = areaByCellId.get(rightCell.id) || 0;
  if (Math.abs(leftArea - rightArea) > EPSILON) {
    return leftArea > rightArea ? leftCell : rightCell;
  }

  return rng.next() < 0.5 ? leftCell : rightCell;
}

function displaceToward(midpoint, target, edgeLength, rng, options) {
  const dx = target.x - midpoint.x;
  const dy = target.y - midpoint.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= EPSILON) {
    return clonePoint(midpoint);
  }

  const ratio = options.minDisplacementRatio + rng.next() * (options.maxDisplacementRatio - options.minDisplacementRatio);
  const displacement = edgeLength * ratio;
  return {
    x: midpoint.x + (dx / distance) * displacement,
    y: midpoint.y + (dy / distance) * displacement,
  };
}

function findRingEdgeIndex(vertexIds, firstVertexId, secondVertexId) {
  for (let index = 0; index < vertexIds.length; index += 1) {
    const from = vertexIds[index];
    const to = vertexIds[(index + 1) % vertexIds.length];
    if ((from === firstVertexId && to === secondVertexId) || (from === secondVertexId && to === firstVertexId)) {
      return index;
    }
  }
  return -1;
}

function insertVertexAfterEdge(vertexIds, edgeIndex, vertexId) {
  return [
    ...vertexIds.slice(0, edgeIndex + 1),
    vertexId,
    ...vertexIds.slice(edgeIndex + 1),
  ];
}

function updateCellGeometry(cell, vertexPoints) {
  cell.vertexIds = normalizeVertexRing(cell.vertexIds);
  cell.polygon = cell.vertexIds.map((vertexId) => clonePoint(vertexPoints.get(vertexId))).filter(Boolean);
  cell.centroid = computePolygonCentroid(cell.polygon);
}
