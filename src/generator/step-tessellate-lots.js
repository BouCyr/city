/*
 * WHAT: Split the largest land lots into simple two-piece sublots.
 * HOW: For the largest half of land lots, choose the shortest split between
 *      existing lot-boundary vertices whose smaller child keeps at least 40% of the parent area.
 * WHY: Step 1.10 should create a sparse, deterministic subdivision based on the lot geometry.
 */

import {
  DEFAULT_SEGMENT_LENGTH,
  clonePoint,
  pointDistance,
} from "./map-model.js";

export function runTessellateLotsStep(map) {
  if (!Array.isArray(map.lots) || !map.lots.length) {
    return {
      map,
      frameEntries: [
        {
          label: "Step 1.10 / Tessellate lot geometry",
          map,
        },
      ],
    };
  }

  const tessellation = buildLotTessellation(map.lots, DEFAULT_SEGMENT_LENGTH);
  const lotSublotIds = new Map();
  const sublotsByLotId = new Map();
  tessellation.sublots.forEach((sublot) => {
    const ids = lotSublotIds.get(sublot.lotId) || [];
    ids.push(sublot.id);
    lotSublotIds.set(sublot.lotId, ids);
    const sublots = sublotsByLotId.get(sublot.lotId) || [];
    sublots.push(sublot);
    sublotsByLotId.set(sublot.lotId, sublots);
  });

  const nextMap = {
    ...map,
    lots: map.lots.map((lot) => ({
      ...lot,
      sublotIds: lotSublotIds.get(lot.id) || [],
      sublots: sublotsByLotId.get(lot.id) || [],
    })),
    tessellation,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.10 / Tessellate lot geometry",
        map: nextMap,
      },
    ],
  };
}

const EPSILON = 0.0001;
const POINT_KEY_DIGITS = 4;
const MIN_SUBLOT_AREA = 0.01;
const SPLIT_LOT_RATIO = 0.5;
const MIN_SPLIT_CHILD_AREA_RATIO = 0.4;
const SPLIT_SEGMENT_LENGTH_RATIO = 0.5;

function buildLotTessellation(lots, segmentLength) {
  const vertices = [];
  const vertexByKey = new Map();
  const sublots = [];
  const selectedLotIds = selectLargestLandLotIds(lots);

  lots.forEach((lot) => {
    const polygon = normalizePolygon(lot.polygon || []);
    if (polygon.length < 3 || Math.abs(computeSignedArea(polygon)) <= EPSILON) {
      return;
    }

    const pieces = selectedLotIds.has(lot.id)
      ? splitLotPolygon(polygon, segmentLength) || [polygon]
      : [polygon];

    pieces.forEach((piece, pieceIndex) => {
      const area = Math.abs(computeSignedArea(piece));
      if (piece.length < 3 || area < MIN_SUBLOT_AREA) {
        return;
      }

      const vertexIds = piece.map((point) => getOrCreateVertex(vertices, vertexByKey, point));
      sublots.push({
        id: sublots.length,
        lotId: lot.id,
        splitIndex: pieceIndex,
        vertexIds,
        centroid: computePolygonCentroid(piece),
        area,
        features: {
          ...(lot.features || {}),
        },
      });
    });
  });

  return {
    vertices,
    sublots,
  };
}

function selectLargestLandLotIds(lots) {
  const landLots = lots
    .map((lot) => ({
      id: lot.id,
      area: Math.abs(computeSignedArea(normalizePolygon(lot.polygon || []))),
      isLand: lot.features?.land !== false && !lot.features?.sea,
    }))
    .filter((lot) => lot.isLand && lot.area > EPSILON)
    .sort((first, second) => {
      if (Math.abs(second.area - first.area) > EPSILON) {
        return second.area - first.area;
      }
      return first.id - second.id;
    });

  const selectedCount = Math.ceil(landLots.length * SPLIT_LOT_RATIO);
  return new Set(landLots.slice(0, selectedCount).map((lot) => lot.id));
}

function splitLotPolygon(polygon, segmentLength) {
  const boundaryPoints = getBoundaryVertices(polygon);
  const split = findShortestBalancedSplit(boundaryPoints);
  if (!split) {
    return null;
  }

  const splitSegmentLength = segmentLength * SPLIT_SEGMENT_LENGTH_RATIO;
  return splitBetweenBoundaryPoints(boundaryPoints, split.firstIndex, split.secondIndex, splitSegmentLength);
}

function getBoundaryVertices(polygon) {
  return normalizePolygon(polygon || []);
}

function findShortestBalancedSplit(boundaryPoints) {
  const totalArea = Math.abs(computeSignedArea(boundaryPoints));
  const minimumChildArea = totalArea * MIN_SPLIT_CHILD_AREA_RATIO;
  let best = null;

  for (let firstIndex = 0; firstIndex < boundaryPoints.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < boundaryPoints.length; secondIndex += 1) {
      if (areAdjacentIndices(firstIndex, secondIndex, boundaryPoints.length)) {
        continue;
      }

      const pieces = splitBetweenBoundaryPoints(boundaryPoints, firstIndex, secondIndex, null);
      const firstArea = Math.abs(computeSignedArea(pieces[0]));
      const secondArea = Math.abs(computeSignedArea(pieces[1]));
      if (Math.min(firstArea, secondArea) + EPSILON < minimumChildArea) {
        continue;
      }

      best = chooseBetterSplitCandidate(best, {
        firstIndex,
        secondIndex,
        length: pointDistance(boundaryPoints[firstIndex], boundaryPoints[secondIndex]),
        balanceGap: Math.abs(firstArea - secondArea),
      });
    }
  }

  return best;
}

function chooseBetterSplitCandidate(current, candidate) {
  if (!candidate) {
    return current;
  }
  if (
    !current
    || candidate.length < current.length - EPSILON
    || (Math.abs(candidate.length - current.length) <= EPSILON && candidate.balanceGap < current.balanceGap)
  ) {
    return candidate;
  }
  return current;
}

function splitBetweenBoundaryPoints(points, firstIndex, secondIndex, splitSegmentLength) {
  const forwardPath = takePathBetweenIndices(points, firstIndex, secondIndex);
  const backwardPath = takePathBetweenIndices(points, secondIndex, firstIndex);
  const chordPoints = splitSegmentLength
    ? resampleSegment(points[firstIndex], points[secondIndex], splitSegmentLength)
    : [points[firstIndex], points[secondIndex]];
  const chordForwardInterior = chordPoints.slice(1, -1);
  const chordBackwardInterior = [...chordForwardInterior].reverse();

  return [
    normalizePolygon([
      ...forwardPath,
      ...chordBackwardInterior,
    ]),
    normalizePolygon([
      ...backwardPath,
      ...chordForwardInterior,
    ]),
  ];
}

function takePathBetweenIndices(points, startIndex, endIndex) {
  const path = [];
  for (let index = startIndex; ; index = (index + 1) % points.length) {
    path.push(clonePoint(points[index]));
    if (index === endIndex) {
      break;
    }
  }
  return path;
}

function areAdjacentIndices(firstIndex, secondIndex, length) {
  return Math.abs(firstIndex - secondIndex) === 1
    || Math.abs(firstIndex - secondIndex) === length - 1;
}

function resampleSegment(from, to, targetLength) {
  const length = pointDistance(from, to);
  const segmentCount = Math.max(1, Math.round(length / targetLength));
  const points = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const t = index / segmentCount;
    points.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    });
  }
  return points;
}

function normalizePolygon(points) {
  const normalized = [];
  points.forEach((point) => {
    const cloned = clonePoint(point);
    const previous = normalized[normalized.length - 1];
    if (!previous || pointDistance(previous, cloned) > EPSILON) {
      normalized.push(cloned);
    }
  });

  if (normalized.length > 1 && pointDistance(normalized[0], normalized[normalized.length - 1]) <= EPSILON) {
    normalized.pop();
  }

  if (computeSignedArea(normalized) < 0) {
    normalized.reverse();
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

function computeSignedArea(polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function getOrCreateVertex(vertices, vertexByKey, point) {
  const key = pointKey(point);
  const existing = vertexByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const id = vertices.length;
  vertices.push({
    id,
    x: point.x,
    y: point.y,
  });
  vertexByKey.set(key, id);
  return id;
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
