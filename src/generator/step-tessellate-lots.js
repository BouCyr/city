/*
 * WHAT: Split the largest land lots into simple two-piece sublots.
 * HOW: For the largest half of land lots, choose the shortest split between canonical lot-boundary vertices
 *      whose smaller child keeps at least 40% of the parent area.
 * WHY: Step 1.11 should create a sparse, deterministic subdivision based on the lot geometry.
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
          label: "Step 1.11 / Tessellate lot geometry",
          map,
        },
      ],
    };
  }

  const tessellation = buildLotTessellation(map, DEFAULT_SEGMENT_LENGTH);
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
        label: "Step 1.11 / Tessellate lot geometry",
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

function buildLotTessellation(map, segmentLength) {
  const lots = map.lots || [];
  const segments = map.segments || [];
  const vertices = [];
  const vertexByKey = new Map();
  const sublots = [];
  const splitLotIds = new Set();
  const selectedLotIds = selectLargestLandLotIds(lots);

  lots.forEach((lot) => {
    const polygon = normalizePolygon(lot.polygon || []);
    if (polygon.length < 3 || Math.abs(computeSignedArea(polygon)) <= EPSILON) {
      return;
    }

    if (!selectedLotIds.has(lot.id)) {
      return;
    }

    const boundaryPoints = getBoundaryVertices(lot, segments);
    const pieces = splitLotPolygon(boundaryPoints, segmentLength);
    if (!pieces || pieces.length < 2) {
      return;
    }

    const validPieces = [];
    pieces.forEach((piece, pieceIndex) => {
      const area = Math.abs(computeSignedArea(piece));
      if (piece.length < 3 || area < MIN_SUBLOT_AREA) {
        return;
      }

      validPieces.push({ piece, pieceIndex, area });
    });
    if (validPieces.length < 2) {
      return;
    }

    splitLotIds.add(lot.id);
    validPieces.forEach(({ piece, pieceIndex, area }) => {
      const vertexIds = piece.map((point) => getOrCreateVertex(vertices, vertexByKey, point));
      sublots.push({
        id: sublots.length,
        lotId: lot.id,
        splitIndex: pieceIndex,
        vertexIds,
        centroid: computePolygonCentroid(piece),
        area,
        neighborSublotIds: [],
        neighborLotIds: [],
        features: {
          ...(lot.features || {}),
        },
      });
    });
  });

  populateSublotNeighbors(sublots, lots, segments, splitLotIds, vertices);

  return {
    vertices,
    sublots,
  };
}

function populateSublotNeighbors(sublots, lots, segments, splitLotIds, vertices) {
  const edgeOwners = new Map();
  sublots.forEach((sublot) => {
    for (let index = 0; index < sublot.vertexIds.length; index += 1) {
      const fromId = sublot.vertexIds[index];
      const toId = sublot.vertexIds[(index + 1) % sublot.vertexIds.length];
      const key = geometryEdgeKey(vertices[fromId], vertices[toId]);
      const owners = edgeOwners.get(key) || [];
      owners.push(sublot.id);
      edgeOwners.set(key, owners);
    }
  });
  lots.forEach((lot) => {
    if (splitLotIds.has(lot.id)) {
      return;
    }

    const polygon = getBoundaryVertices(lot, segments);
    for (let index = 0; index < polygon.length; index += 1) {
      const from = polygon[index];
      const to = polygon[(index + 1) % polygon.length];
      const key = geometryEdgeKey(from, to);
      const owners = edgeOwners.get(key) || [];
      owners.push(`lot:${lot.id}`);
      edgeOwners.set(key, owners);
    }
  });

  const sublotById = new Map(sublots.map((sublot) => [sublot.id, sublot]));
  edgeOwners.forEach((owners) => {
    if (owners.length < 2) {
      return;
    }

    owners.forEach((ownerKey) => {
      if (typeof ownerKey !== "number") {
        return;
      }

      const owner = sublotById.get(ownerKey);
      if (!owner) {
        return;
      }
      owners.forEach((neighborKey) => {
        if (neighborKey === ownerKey) {
          return;
        }

        if (typeof neighborKey === "number" && !owner.neighborSublotIds.includes(neighborKey)) {
          owner.neighborSublotIds.push(neighborKey);
          return;
        }

        if (typeof neighborKey === "string") {
          const lotId = Number(neighborKey.slice(4));
          if (Number.isFinite(lotId) && !owner.neighborLotIds.includes(lotId)) {
            owner.neighborLotIds.push(lotId);
          }
        }
      });
    });
  });

  sublots.forEach((sublot) => {
    sublot.neighborSublotIds.sort((first, second) => first - second);
    sublot.neighborLotIds.sort((first, second) => first - second);
  });
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

function splitLotPolygon(boundaryPoints, segmentLength) {
  const split = findShortestBalancedSplit(boundaryPoints);
  if (!split) {
    return null;
  }

  const splitSegmentLength = segmentLength * SPLIT_SEGMENT_LENGTH_RATIO;
  return splitBetweenBoundaryPoints(boundaryPoints, split.firstIndex, split.secondIndex, splitSegmentLength);
}

function getBoundaryVertices(lot, segments) {
  const polygon = normalizePolygon(lot.polygon || []);
  const boundaryPoints = collectSegmentBoundaryPoints(lot, segments);
  if (!boundaryPoints.length) {
    return polygon;
  }

  const expanded = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    expanded.push(clonePoint(from));

    boundaryPoints
      .filter((point) => !pointsMatch(point, from) && !pointsMatch(point, to))
      .filter((point) => pointLiesOnSegment(point, from, to))
      .sort((first, second) => pointDistance(from, first) - pointDistance(from, second))
      .forEach((point) => {
        const previous = expanded[expanded.length - 1];
        if (!previous || !pointsMatch(previous, point)) {
          expanded.push(clonePoint(point));
        }
      });
  }

  return normalizePolygon(expanded);
}

function collectSegmentBoundaryPoints(lot, segments) {
  const pointsByKey = new Map();
  segments.forEach((segment) => {
    if (segment.leftLotId !== lot.id && segment.rightLotId !== lot.id) {
      return;
    }

    pointsByKey.set(pointKey(segment.from), clonePoint(segment.from));
    pointsByKey.set(pointKey(segment.to), clonePoint(segment.to));
  });
  return Array.from(pointsByKey.values());
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

function pointLiesOnSegment(point, from, to) {
  const segmentLength = pointDistance(from, to);
  if (segmentLength <= EPSILON) {
    return false;
  }

  const offset = Math.abs((to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x));
  if (offset > EPSILON * Math.max(1, segmentLength)) {
    return false;
  }

  const along = ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / (segmentLength ** 2);
  return along > EPSILON && along < 1 - EPSILON;
}

function pointsMatch(first, second) {
  return pointDistance(first, second) <= EPSILON;
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

function geometryEdgeKey(from, to) {
  const fromKey = pointKey(from);
  const toKey = pointKey(to);
  return fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
