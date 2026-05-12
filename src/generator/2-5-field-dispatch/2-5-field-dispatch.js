/*
 * WHAT: Split land lots into deterministic leaf sublots.
 * HOW: Use the selected tessellation algorithm to recurse with balanced straight or curved bisections.
 * WHY: Both algorithms preserve the same tessellation output contract for replay and hover UI.
 */

import {
  DEFAULT_SEGMENT_LENGTH,
  clonePoint,
  pointDistance,
} from "../map-model.js";
import { addAlleyRoutesToRouteGraph } from "../route-graph.js";
import { buildCurvedBisectionSplitPath } from "./2-5-curved-bisection.js";
import { buildStraightBisectionSplitPath } from "./2-5-straight-bisection.js";

export function runFieldDispatchStep(map, { onProgress = null }) {
  if (!Array.isArray(map.lots) || !map.lots.length) {
        const label = "Step 2.5 / Field dispatch";
        return {
          map,
          frameEntries: [
            {
              label,
              map,
            },
          ],
        };
  }

  const algorithm = map.init?.params?.stepAlgorithms?.tessellateLots || "curved_bisection";
  const curveAmplitude = CURVE_TENSION_RATIO;
  let lastProgressAt = 0;
  const tessellation = buildLotTessellation(map, DEFAULT_SEGMENT_LENGTH, algorithm, curveAmplitude, (progress) => {
    if (typeof onProgress !== "function") {
      return;
    }
    const now = getTimestamp();
    if (progress.completed < progress.total && now - lastProgressAt < PROGRESS_UPDATE_INTERVAL_MS) {
      return;
    }
      lastProgressAt = now;
    const progressTessellation = {
      vertices: progress.vertices.map((vertex) => ({ ...vertex })),
      sublots: progress.sublots.map((sublot) => cloneSublot(sublot)),
    };
      onProgress({
      label: `Step 2.5 / Field dispatch (${progress.completed}/${progress.total})`,
      map: buildTessellatedMap(map, progressTessellation),
      progress: {
        completed: progress.completed,
        total: progress.total,
      },
    });
  });
  const nextMap = buildTessellatedMap(map, tessellation);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.5 / Field dispatch",
        map: nextMap,
      },
    ],
  };
}

const EPSILON = 0.0001;
const POINT_KEY_DIGITS = 4;
const MAX_TESSELLATED_LOTS = 1;
const MIN_SUBLOT_AREA = 0.01;
const MIN_SPLIT_CHILD_AREA_RATIO = 0.4;
const MIN_RECURSIVE_SPLIT_AREA_RATIO = 3;
const SPLIT_SEGMENT_LENGTH_RATIO = 0.5;
const CURVE_TENSION_RATIO = 0.35;
const CURVE_SAMPLING_STEPS = 24;
const PROGRESS_UPDATE_INTERVAL_MS = 150;
const SEGMENT_SPATIAL_BUCKET_SIZE = DEFAULT_SEGMENT_LENGTH * 2;

function buildLotTessellation(map, segmentLength, algorithm, curveAmplitude, onLotComplete = null) {
  const lots = map.lots || [];
  const segments = map.segments || [];
  const boundaryPointLookup = buildLotBoundaryPointLookup(segments);
  const vertices = [];
  const vertexByKey = new Map();
  const sublots = [];
  const landLots = lots
    .map((lot) => {
      const polygon = normalizePolygon(lot.polygon || [])
      const area = Math.abs(computeSignedArea(polygon))
      return { lot, area, polygon }
    })
    .filter((item) => item.polygon.length >= 3 && item.area > EPSILON && isLandLot(item.lot) && !item.lot.features?.boundary)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_TESSELLATED_LOTS)
    .map((item) => item.lot)
  let completedLots = 0;

  landLots.forEach((lot) => {
    const boundaryPoints = getBoundaryVertices(lot, boundaryPointLookup.get(lot.id) || []);
    const pieces = splitLotPolygonRecursively(boundaryPoints, segmentLength, algorithm, curveAmplitude);
    appendSublotsForLot(lot, pieces, vertices, vertexByKey, sublots);
    completedLots += 1;
    onLotComplete?.({
      completed: completedLots,
      total: landLots.length,
      lotId: lot.id,
      vertices,
      sublots,
    });
  });

  populateSublotNeighbors(sublots, segments, vertices);

  return {
    vertices,
    sublots,
  };
}

function appendSublotsForLot(lot, pieces, vertices, vertexByKey, sublots) {
  if (pieces.length < 2) {
    return;
  }

  const validPieces = pieces
    .map((piece, pieceIndex) => ({
      piece: normalizePolygon(piece),
      pieceIndex,
      area: Math.abs(computeSignedArea(piece)),
    }))
    .filter(({ piece, area }) => piece.length >= 3 && area >= MIN_SUBLOT_AREA);
  if (validPieces.length < 2) {
    return;
  }

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
}

function buildTessellatedMap(map, tessellation) {
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

  const mapWithSublots = {
    ...map,
    lots: map.lots.map((lot) => ({
      ...lot,
      sublotIds: lotSublotIds.get(lot.id) || [],
      sublots: sublotsByLotId.get(lot.id) || [],
    })),
    tessellation,
  };

  return {
    ...mapWithSublots,
    routeGraph: addAlleyRoutesToRouteGraph(mapWithSublots, tessellation),
  };
}

function cloneSublot(sublot) {
  return {
    ...sublot,
    vertexIds: [...sublot.vertexIds],
    centroid: { ...sublot.centroid },
    neighborSublotIds: [...sublot.neighborSublotIds],
    neighborLotIds: [...sublot.neighborLotIds],
    features: { ...sublot.features },
  };
}

function getTimestamp() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function cross2d(from, to, point) {
  return ((to.x - from.x) * (point.y - from.y)) - ((to.y - from.y) * (point.x - from.x));
}

function computeBounds(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

function expandBounds(bounds, padding) {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

export function splitLotPolygonRecursively(boundaryPoints, segmentLength, algorithm = "straight_bisection", curveAmplitude = CURVE_TENSION_RATIO, normalGuides = [], observer = null) {
  const minimumLeafArea = (segmentLength ** 2) * MIN_RECURSIVE_SPLIT_AREA_RATIO;
  const leaves = [];
  const polygon = normalizePolygon(boundaryPoints);
  splitBranch({
    polygon,
    partition: observer ? [polygon] : null,
    blockedVertexKeys: new Set(),
    algorithm,
    curveAmplitude,
    segmentLength,
    minimumLeafArea,
    leaves,
    normalGuides,
    observer,
    depth: 0,
  });
  return leaves;
}

function splitBranch({ polygon, partition, blockedVertexKeys, segmentLength, minimumLeafArea, leaves, algorithm, curveAmplitude, normalGuides, observer, depth }) {
  const area = Math.abs(computeSignedArea(polygon));
  if (polygon.length < 3 || area <= minimumLeafArea) {
    leaves.push(polygon);
    if (observer) {
      observer({
      type: "leaf",
      polygon,
      partition,
      depth,
      area,
      minimumLeafArea,
      });
    }
    return;
  }

  const candidates = findBalancedSplitCandidates(polygon, blockedVertexKeys);
  if (observer) {
    observer({
    type: "candidates",
    polygon,
    partition,
    depth,
    blockedVertexKeys: new Set(blockedVertexKeys),
    candidates,
    });
  }
  const split = candidates[0] || null;
  if (!split) {
    leaves.push(polygon);
    if (observer) {
      observer({
      type: "no-split",
      polygon,
      partition,
      depth,
      });
    }
    return;
  }
  if (observer) {
    observer({
    type: "selected",
    polygon,
    partition,
    depth,
    split,
    });
  }

  const splitSegmentLength = segmentLength * SPLIT_SEGMENT_LENGTH_RATIO;
  const splitPath = buildSplitPath(
    polygon,
    split.firstIndex,
    split.secondIndex,
    splitSegmentLength,
    algorithm,
    curveAmplitude,
    normalGuides,
  );
  if (observer) {
    observer({
    type: "computed",
    polygon,
    partition,
    depth,
    split,
    splitPath,
    });
  }
  const pieces = splitBetweenBoundaryPoints(
    polygon,
    split.firstIndex,
    split.secondIndex,
    splitPath,
  );
  const nextBlockedVertexKeys = new Set(blockedVertexKeys);
  nextBlockedVertexKeys.add(pointKey(polygon[split.firstIndex]));
  nextBlockedVertexKeys.add(pointKey(polygon[split.secondIndex]));
  const childPolygons = pieces
    .map((piece) => normalizePolygon(piece))
    .filter((piece) => piece.length >= 3 && Math.abs(computeSignedArea(piece)) >= MIN_SUBLOT_AREA);
  if (childPolygons.length < 2) {
    leaves.push(polygon);
    if (observer) {
      observer({
      type: "rejected",
      polygon,
      partition,
      depth,
      split,
      splitPath,
      });
    }
    return;
  }
  if (partition) {
    replacePartitionLeaf(partition, polygon, childPolygons);
  }
  if (observer) {
    observer({
    type: "children",
    polygon,
    partition,
    depth,
    split,
    splitPath,
    pieces: childPolygons,
    });
  }

  childPolygons.forEach((normalizedPiece) => {
    splitBranch({
      polygon: normalizedPiece,
      partition,
      blockedVertexKeys: nextBlockedVertexKeys,
      algorithm,
      curveAmplitude,
      segmentLength,
      minimumLeafArea,
      leaves,
      normalGuides,
      observer,
      depth: depth + 1,
    });
  });
}

function populateSublotNeighbors(sublots, segments, vertices) {
  const segmentSpatialIndex = buildSegmentSpatialIndex(segments);
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

  const sublotById = new Map(sublots.map((sublot) => [sublot.id, sublot]));
  edgeOwners.forEach((owners) => {
    if (owners.length < 2) {
      return;
    }

    owners.forEach((ownerId) => {
      const owner = sublotById.get(ownerId);
      if (!owner) {
        return;
      }

      owners.forEach((neighborId) => {
        if (neighborId === ownerId) {
          return;
        }
        if (!owner.neighborSublotIds.includes(neighborId)) {
          owner.neighborSublotIds.push(neighborId);
        }
      });
    });
  });

  sublots.forEach((sublot) => {
    for (let index = 0; index < sublot.vertexIds.length; index += 1) {
      const from = vertices[sublot.vertexIds[index]];
      const to = vertices[sublot.vertexIds[(index + 1) % sublot.vertexIds.length]];
      findNeighborLotIdsForEdge(sublot.lotId, from, to, segmentSpatialIndex).forEach((neighborLotId) => {
        if (!sublot.neighborLotIds.includes(neighborLotId)) {
          sublot.neighborLotIds.push(neighborLotId);
        }
      });
    }

    sublot.neighborSublotIds.sort((first, second) => first - second);
    sublot.neighborLotIds.sort((first, second) => first - second);
  });
}

function findNeighborLotIdsForEdge(lotId, from, to, segmentSpatialIndex) {
  const neighborLotIds = new Set();
  querySegmentSpatialIndex(segmentSpatialIndex, computeBounds([from, to])).forEach((segment) => {
    if (segment.leftLotId !== lotId && segment.rightLotId !== lotId) {
      return;
    }
    if (!segmentsOverlapOnLine(from, to, segment.from, segment.to)) {
      return;
    }

    const otherLotId = segment.leftLotId === lotId ? segment.rightLotId : segment.leftLotId;
    if (otherLotId !== null && otherLotId !== undefined && otherLotId !== lotId) {
      neighborLotIds.add(otherLotId);
    }
  });
  return Array.from(neighborLotIds);
}

function segmentsOverlapOnLine(firstFrom, firstTo, secondFrom, secondTo) {
  if (!pointLiesOnSegment(firstFrom, secondFrom, secondTo) && !pointLiesOnSegment(firstTo, secondFrom, secondTo)
    && !pointLiesOnSegment(secondFrom, firstFrom, firstTo) && !pointLiesOnSegment(secondTo, firstFrom, firstTo)) {
    return false;
  }

  const firstLength = pointDistance(firstFrom, firstTo);
  const secondLength = pointDistance(secondFrom, secondTo);
  if (firstLength <= EPSILON || secondLength <= EPSILON) {
    return false;
  }

  return Math.abs(cross2d(firstFrom, firstTo, secondFrom)) <= EPSILON * Math.max(1, firstLength)
    && Math.abs(cross2d(firstFrom, firstTo, secondTo)) <= EPSILON * Math.max(1, firstLength);
}

function isLandLot(lot) {
  return lot.features?.land !== false && !lot.features?.sea;
}

function getBoundaryVertices(lot, boundaryPoints) {
  const polygon = normalizePolygon(lot.polygon || []);
  if (!boundaryPoints.length) {
    return polygon;
  }
  return reinsertBoundaryVertices(polygon, boundaryPoints);
}

function reinsertBoundaryVertices(polygon, boundaryPoints) {
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

function buildLotBoundaryPointLookup(segments) {
  const pointsByLotId = new Map();
  segments.forEach((segment) => {
    const lotIds = [segment.leftLotId, segment.rightLotId].filter((lotId) => lotId !== null && lotId !== undefined);
    lotIds.forEach((lotId) => {
      const pointsByKey = pointsByLotId.get(lotId) || new Map();
      pointsByKey.set(pointKey(segment.from), clonePoint(segment.from));
      pointsByKey.set(pointKey(segment.to), clonePoint(segment.to));
      pointsByLotId.set(lotId, pointsByKey);
    });
  });

  const lookup = new Map();
  pointsByLotId.forEach((pointsByKey, lotId) => {
    lookup.set(lotId, Array.from(pointsByKey.values()));
  });
  return lookup;
}

function buildSegmentSpatialIndex(segments) {
  const buckets = new Map();
  segments.forEach((segment) => {
    const bounds = expandBounds(computeBounds([segment.from, segment.to]), EPSILON);
    forEachSegmentBucket(bounds, (bucketKey) => {
      const bucket = buckets.get(bucketKey) || [];
      bucket.push(segment);
      buckets.set(bucketKey, bucket);
    });
  });
  return buckets;
}

function querySegmentSpatialIndex(index, bounds) {
  const seen = new Set();
  const matches = [];
  forEachSegmentBucket(expandBounds(bounds, EPSILON), (bucketKey) => {
    const bucket = index.get(bucketKey) || [];
    bucket.forEach((segment) => {
      if (seen.has(segment.id)) {
        return;
      }
      seen.add(segment.id);
      matches.push(segment);
    });
  });
  return matches;
}

function forEachSegmentBucket(bounds, callback) {
  const minBucketX = Math.floor(bounds.minX / SEGMENT_SPATIAL_BUCKET_SIZE);
  const maxBucketX = Math.floor(bounds.maxX / SEGMENT_SPATIAL_BUCKET_SIZE);
  const minBucketY = Math.floor(bounds.minY / SEGMENT_SPATIAL_BUCKET_SIZE);
  const maxBucketY = Math.floor(bounds.maxY / SEGMENT_SPATIAL_BUCKET_SIZE);

  for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX += 1) {
    for (let bucketY = minBucketY; bucketY <= maxBucketY; bucketY += 1) {
      callback(`${bucketX},${bucketY}`);
    }
  }
}

function findBalancedSplitCandidates(boundaryPoints, blockedVertexKeys = new Set()) {
  const totalSignedArea = computeSignedArea(boundaryPoints);
  const totalArea = Math.abs(totalSignedArea);
  const minimumChildArea = totalArea * MIN_SPLIT_CHILD_AREA_RATIO;
  const prefixCross = buildPrefixCrossSums(boundaryPoints);
  const candidates = [];

  for (let firstIndex = 0; firstIndex < boundaryPoints.length; firstIndex += 1) {
    if (blockedVertexKeys.has(pointKey(boundaryPoints[firstIndex]))) {
      continue;
    }

    for (let secondIndex = firstIndex + 1; secondIndex < boundaryPoints.length; secondIndex += 1) {
      if (blockedVertexKeys.has(pointKey(boundaryPoints[secondIndex]))) {
        continue;
      }
      if (areAdjacentIndices(firstIndex, secondIndex, boundaryPoints.length)) {
        continue;
      }

      const firstArea = computeSplitArea(boundaryPoints, prefixCross, firstIndex, secondIndex);
      const secondArea = Math.abs(totalArea - firstArea);
      if (Math.min(firstArea, secondArea) + EPSILON < minimumChildArea) {
        continue;
      }

      candidates.push({
        firstIndex,
        secondIndex,
        length: pointDistance(boundaryPoints[firstIndex], boundaryPoints[secondIndex]),
        balanceGap: Math.abs(firstArea - secondArea),
      });
    }
  }

  return candidates.sort((first, second) => first.length - second.length || first.balanceGap - second.balanceGap);
}

function buildPrefixCrossSums(points) {
  const prefixCross = new Array(points.length + 1).fill(0);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    prefixCross[index + 1] = prefixCross[index] + ((current.x * next.y) - (next.x * current.y));
  }
  return prefixCross;
}

function computeSplitArea(points, prefixCross, firstIndex, secondIndex) {
  const chordCross = (points[secondIndex].x * points[firstIndex].y) - (points[firstIndex].x * points[secondIndex].y);
  const pathCross = prefixCross[secondIndex] - prefixCross[firstIndex];
  return Math.abs((pathCross + chordCross) / 2);
}

function splitBetweenBoundaryPoints(
  points,
  firstIndex,
  secondIndex,
  chordPoints,
) {
  const forwardPath = takePathBetweenIndices(points, firstIndex, secondIndex);
  const backwardPath = takePathBetweenIndices(points, secondIndex, firstIndex);
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

function buildSplitPath(points, firstIndex, secondIndex, splitSegmentLength, algorithm = "straight_bisection", curveAmplitude = CURVE_TENSION_RATIO, normalGuides = null) {
  return algorithm === "curved_bisection"
    ? buildCurvedBisectionSplitPath(points, firstIndex, secondIndex, splitSegmentLength, curveAmplitude, normalGuides)
    : buildStraightBisectionSplitPath(points[firstIndex], points[secondIndex], splitSegmentLength);
}

function replacePartitionLeaf(partition, leaf, childPolygons) {
  const index = partition.findIndex((piece) => samePolygon(piece, leaf));
  if (index < 0) {
    partition.push(...childPolygons);
    return partition;
  }
  partition.splice(index, 1, ...childPolygons);
  return partition;
}

function samePolygon(first, second) {
  if (!first || !second || first.length !== second.length) {
    return false;
  }
  return first.every((point, index) => pointDistance(point, second[index]) <= EPSILON);
}

function resamplePolyline(points, segmentCount) {
  if (points.length <= 2) {
    return points.map((point) => clonePoint(point));
  }

  const cumulativeDistances = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulativeDistances[index] = cumulativeDistances[index - 1] + pointDistance(points[index - 1], points[index]);
  }

  const totalLength = cumulativeDistances[cumulativeDistances.length - 1];
  if (totalLength <= EPSILON) {
    return [clonePoint(points[0]), clonePoint(points[points.length - 1])];
  }

  const resampled = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const targetDistance = (totalLength * index) / segmentCount;
    resampled.push(sampleAlongPolyline(points, cumulativeDistances, targetDistance));
  }
  return resampled;
}

function sampleAlongPolyline(points, cumulativeDistances, targetDistance) {
  if (targetDistance <= 0) {
    return clonePoint(points[0]);
  }
  const totalLength = cumulativeDistances[cumulativeDistances.length - 1];
  if (targetDistance >= totalLength) {
    return clonePoint(points[points.length - 1]);
  }

  for (let index = 1; index < cumulativeDistances.length; index += 1) {
    if (targetDistance > cumulativeDistances[index] + EPSILON) {
      continue;
    }

    const segmentLength = cumulativeDistances[index] - cumulativeDistances[index - 1];
    if (segmentLength <= EPSILON) {
      return clonePoint(points[index]);
    }

    const localT = (targetDistance - cumulativeDistances[index - 1]) / segmentLength;
    return {
      x: points[index - 1].x + ((points[index].x - points[index - 1].x) * localT),
      y: points[index - 1].y + ((points[index].y - points[index - 1].y) * localT),
    };
  }

  return clonePoint(points[points.length - 1]);
}

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += pointDistance(points[index - 1], points[index]);
  }
  return total;
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
  return along > -EPSILON && along < 1 + EPSILON;
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

  if (normalized.length >= 3 && computeSignedArea(normalized) < 0) {
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
