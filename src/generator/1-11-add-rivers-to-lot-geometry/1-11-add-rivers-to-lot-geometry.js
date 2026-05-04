/*
 * WHAT: Split canonical lots along the sampled river network after lot conversion.
 * HOW: Resample rivers into shared segment geometry, insert their crossings into lot boundaries,
 *      then trace the planar faces created inside each affected lot.
 * WHY: Rivers should become part of the lot topology instead of only drawing as an overlay.
 */

import { cross } from "../geometry.js";
import {
  DEFAULT_SEGMENT_LENGTH,
  clonePoint,
  dedupeConsecutivePoints,
  midpointBetween,
  normalizePolyline,
  pointDistance,
  resamplePolyline,
} from "../map-model.js";

export function runAddRiversToLotGeometryStep(map) {
  if (!Array.isArray(map.lots) || !map.lots.length || !Array.isArray(map.rivers) || !map.rivers.length) {
    return {
      map,
      frameEntries: [
        {
          label: "Step 1.11 / River splits",
          map,
        },
      ],
    };
  }

  const riverGraph = buildRiverSegmentModel(map.rivers);
  const nextMap = splitLotsByRiverGraph(map, riverGraph);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.11 / River splits",
        map: nextMap,
      },
    ],
  };
}

const EPSILON = 0.0001;
const POINT_EPSILON = 0.05;
const GRAPH_NODE_EPSILON = 0.05;
const RIVER_SPAN_EPSILON = 0.5;
const SPATIAL_BUCKET_SIZE = DEFAULT_SEGMENT_LENGTH * 2;
const TRIBUTARY_MERGE_DOWNSTREAM_RATIO = 0.33;

function buildRiverSegmentModel(rivers) {
  const nodes = [];
  const segments = [];
  const nodeByKey = new Map();
  const adjustedPointsByRiverId = buildAdjustedRiverPointMap(rivers);
  const riverBranchByRiverId = new Map();
  rivers.forEach((river) => {
    if (isTributaryRiver(river)) {
      riverBranchByRiverId.set(river.id, "tributary");
      return;
    }

    if (river.widthMergeCellId !== null && river.widthMergeCellId !== undefined) {
      riverBranchByRiverId.set(river.id, "primary");
      return;
    }

    riverBranchByRiverId.set(river.id, "primary");
  });

  const mergePointByRiverId = new Map();
  const pinnedPointKeys = new Set();
  rivers.forEach((river) => {
    if (river.mergeCellId === null || river.mergeCellId === undefined) {
      return;
    }

    const mergeIndex = river.cellIds?.indexOf(river.mergeCellId) ?? -1;
    if (mergeIndex < 0) {
      return;
    }

    const riverPoints = adjustedPointsByRiverId.get(river.id) || normalizePolyline(river.points || []);
    const pointIndex = riverPoints.length - 1;
    if (pointIndex >= 0) {
      mergePointByRiverId.set(river.id, clonePoint(riverPoints[pointIndex]));
      pinnedPointKeys.add(pointKey(riverPoints[pointIndex]));
    }
  });
  rivers.forEach((river) => {
    if (river.widthMergeCellId === null || river.widthMergeCellId === undefined) {
      return;
    }

    const mergePointIndex = findPrimaryMergePointIndex(river);
    const riverPoints = adjustedPointsByRiverId.get(river.id) || normalizePolyline(river.points || []);
    if (mergePointIndex !== null && riverPoints[mergePointIndex]) {
      pinnedPointKeys.add(pointKey(riverPoints[mergePointIndex]));
    }
  });

  rivers.forEach((river) => {
    const points = adjustedPointsByRiverId.get(river.id) || normalizePolyline(river.points || []);
    if (points.length < 2) {
      return;
    }

    const mergeIndex = findPrimaryMergePointIndex(river);
    const smoothedPoints = smoothRiverPolyline(points, pinnedPointKeys);
    let segmentCursor = 0;

    for (let index = 0; index < smoothedPoints.length - 1; index += 1) {
        const fromPoint = smoothedPoints[index];
        const toPoint = smoothedPoints[index + 1];
        const fromNodeId = getOrCreateNode(nodes, nodeByKey, fromPoint);
        const toNodeId = getOrCreateNode(nodes, nodeByKey, toPoint);
        if (fromNodeId === toNodeId) {
          continue;
        }

        const samplePosition = mapSmoothedRiverSamplePosition(points, smoothedPoints, index);
        const branchType = resolveRiverBranchType(river, samplePosition, mergeIndex, riverBranchByRiverId.get(river.id));
        segments.push({
          id: `river:${river.id}:${segmentCursor}`,
          riverId: river.id,
          branchType,
          fromNodeId,
          toNodeId,
          from: clonePoint(nodes[fromNodeId]),
          to: clonePoint(nodes[toNodeId]),
          midpoint: midpointBetween(nodes[fromNodeId], nodes[toNodeId]),
          length: pointDistance(nodes[fromNodeId], nodes[toNodeId]),
        });
        segmentCursor += 1;
    }
  });

  return {
    nodes,
    segments: dedupeRiverSegments(segments),
  };
}

function buildAdjustedRiverPointMap(rivers) {
  const pointsByRiverId = new Map(rivers.map((river) => [
    river.id,
    normalizePolyline(river.points || []),
  ]));

  rivers.forEach((river) => {
    if (!isTributaryRiver(river)) {
      return;
    }

    const tributaryPoints = pointsByRiverId.get(river.id);
    const primaryRiver = rivers.find((candidate) => candidate.id === river.mergedIntoRiverId);
    const primaryPoints = primaryRiver ? pointsByRiverId.get(primaryRiver.id) : null;
    const primaryMergePointIndex = primaryRiver ? findPrimaryMergePointIndexForCell(primaryRiver, river.mergeCellId) : null;
    if (
      !tributaryPoints
      || tributaryPoints.length < 2
      || !primaryPoints
      || primaryMergePointIndex === null
      || !primaryPoints[primaryMergePointIndex]
    ) {
      return;
    }

    const mergePoint = primaryPoints[primaryMergePointIndex];
    const downstreamPoint = primaryPoints[Math.min(primaryMergePointIndex + 1, primaryPoints.length - 1)];
    const shiftedMergePoint = downstreamPoint && !pointsMatch(mergePoint, downstreamPoint)
      ? pointAlongSegment(mergePoint, downstreamPoint, TRIBUTARY_MERGE_DOWNSTREAM_RATIO)
      : clonePoint(mergePoint);

    primaryPoints[primaryMergePointIndex] = clonePoint(shiftedMergePoint);
    tributaryPoints[tributaryPoints.length - 1] = clonePoint(shiftedMergePoint);
  });

  return pointsByRiverId;
}

function isTributaryRiver(river) {
  return river.mergedIntoRiverId !== null && river.mergedIntoRiverId !== undefined;
}

function smoothRiverPolyline(points, pinnedPointKeys, targetLength = DEFAULT_SEGMENT_LENGTH) {
  if (points.length < 3) {
    return resamplePolyline(points, Math.max(1, Math.ceil(polylineLength(points) / targetLength)));
  }

  const segmentPaths = Array.from({ length: points.length - 1 }, () => ({
    fromToMidpoint: null,
    midpointToTo: null,
  }));

  for (let index = 0; index < points.length; index += 1) {
    const control = points[index];
    const previousMidpoint = index > 0 ? midpointBetween(points[index - 1], control) : null;
    const nextMidpoint = index < points.length - 1 ? midpointBetween(control, points[index + 1]) : null;
    const isPinned = index === 0 || index === points.length - 1 || pinnedPointKeys.has(pointKey(control));
    const start = previousMidpoint || mirrorPoint(nextMidpoint, control);
    const end = nextMidpoint || mirrorPoint(previousMidpoint, control);
    const curve = sampleQuadraticBezier(start, control, end, targetLength);
    const splitIndex = isPinned ? findClosestPointIndex(curve, control) : findClosestPointIndex(curve, control);
    const splitPoint = isPinned ? clonePoint(control) : clonePoint(curve[splitIndex]);

    if (index > 0) {
      segmentPaths[index - 1].midpointToTo = dedupeConsecutivePoints([
        ...curve.slice(0, splitIndex),
        splitPoint,
      ]);
    }
    if (index < points.length - 1) {
      segmentPaths[index].fromToMidpoint = dedupeConsecutivePoints([
        splitPoint,
        ...curve.slice(splitIndex + 1),
      ]);
    }
  }

  const smoothed = [];
  segmentPaths.forEach((entry, index) => {
    const fallback = resamplePolyline([points[index], points[index + 1]], Math.max(1, Math.ceil(pointDistance(points[index], points[index + 1]) / targetLength)));
    const path = entry.fromToMidpoint && entry.midpointToTo
      ? dedupeConsecutivePoints([...entry.fromToMidpoint, ...entry.midpointToTo.slice(1)])
      : fallback;
    appendPath(smoothed, path);
  });

  return dedupeConsecutivePoints(smoothed);
}

function mapSmoothedRiverSamplePosition(originalPoints, smoothedPoints, sampleIndex) {
  const midpoint = midpointBetween(smoothedPoints[sampleIndex], smoothedPoints[sampleIndex + 1]);
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < originalPoints.length - 1; index += 1) {
    const distance = pointDistanceToSegment(midpoint, originalPoints[index], originalPoints[index + 1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function sampleQuadraticBezier(start, control, end, targetLength) {
  const approximateLength = pointDistance(start, control) + pointDistance(control, end);
  const segmentCount = Math.max(2, Math.ceil(approximateLength / Math.max(EPSILON, targetLength)));
  const points = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const t = index / segmentCount;
    const inverse = 1 - t;
    points.push({
      x: (inverse * inverse * start.x) + (2 * inverse * t * control.x) + (t * t * end.x),
      y: (inverse * inverse * start.y) + (2 * inverse * t * control.y) + (t * t * end.y),
    });
  }
  return dedupeConsecutivePoints(points);
}

function findClosestPointIndex(points, target) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = pointDistance(point, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function pointDistanceToSegment(point, from, to) {
  const length = pointDistance(from, to);
  if (length <= EPSILON) {
    return pointDistance(point, from);
  }
  const along = Math.max(0, Math.min(1, ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / (length ** 2)));
  return pointDistance(point, pointAlongSegment(from, to, along));
}

function mirrorPoint(point, origin) {
  return {
    x: (origin.x * 2) - point.x,
    y: (origin.y * 2) - point.y,
  };
}

function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += pointDistance(points[index - 1], points[index]);
  }
  return length;
}

function appendPath(target, path) {
  path.forEach((point) => {
    const previous = target[target.length - 1];
    if (!previous || !pointsMatch(previous, point)) {
      target.push(clonePoint(point));
    }
  });
}

function splitLotsByRiverGraph(map, riverGraph) {
  const nextLotId = {
    value: Math.max(-1, ...map.lots.map((lot) => lot.id)) + 1,
  };
  const splitLots = [];
  const riverSpatialIndex = buildSegmentSpatialIndex(riverGraph.segments);

  map.lots.forEach((lot) => {
    const splitPolygons = splitLotPolygon(lot, riverSpatialIndex);
    if (splitPolygons.length <= 1) {
      splitLots.push({
        ...lot,
        polygon: splitPolygons[0] || lot.polygon.map((point) => clonePoint(point)),
      });
      return;
    }

    splitPolygons.forEach((polygon, index) => {
      splitLots.push(createSplitLot(lot, polygon, index === 0 ? lot.id : nextLotId.value++));
    });
  });

  const rebuilt = rebuildSegmentsFromLots(splitLots, riverGraph);
  return {
    ...map,
    vertices: rebuilt.vertices,
    lots: rebuilt.lots,
    segments: rebuilt.segments,
  };
}

function splitLotPolygon(lot, riverSpatialIndex) {
  const polygon = normalizePolygon(lot.polygon);
  const polygonBounds = computeBounds(polygon);
  const clippedEdges = querySpatialIndex(riverSpatialIndex, polygonBounds)
    .map((segment) => clipRiverSegmentToConvexPolygon(segment, polygon))
    .filter(Boolean);

  if (!clippedEdges.length) {
    return [polygon];
  }

  const graph = buildLotSplitGraph(polygon, clippedEdges);
  const faces = traceGraphFaces(graph);
  const polygons = faces
    .map((face) => normalizePolygon(face.map((nodeId) => graph.nodes[nodeId])))
    .filter((facePolygon) => facePolygon.length >= 3 && Math.abs(computeSignedArea(facePolygon)) > EPSILON)
    .filter((facePolygon) => pointInPolygon(computePolygonCentroid(facePolygon), polygon))
    .filter((facePolygon, index, collection) => !collection.some((other, otherIndex) => otherIndex < index && polygonsMatch(facePolygon, other)));

  return polygons.length ? polygons : [polygon];
}

function buildSegmentSpatialIndex(segments) {
  const buckets = new Map();
  segments.forEach((segment) => {
    const bounds = computeBounds([segment.from, segment.to]);
    forEachBucket(bounds, (bucketKey) => {
      const bucket = buckets.get(bucketKey) || [];
      bucket.push(segment);
      buckets.set(bucketKey, bucket);
    });
  });
  return buckets;
}

function querySpatialIndex(index, bounds) {
  const seen = new Set();
  const matches = [];
  forEachBucket(bounds, (bucketKey) => {
    const bucket = index.get(bucketKey) || [];
    bucket.forEach((segment) => {
      if (seen.has(segment.id)) {
        return;
      }
      seen.add(segment.id);
      if (boundsOverlap(bounds, computeBounds([segment.from, segment.to]))) {
        matches.push(segment);
      }
    });
  });
  return matches;
}

function buildPointSpatialIndex(points) {
  const buckets = new Map();
  points.forEach((point) => {
    const bucketKey = spatialBucketKey(point.x, point.y);
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(point);
    buckets.set(bucketKey, bucket);
  });
  return buckets;
}

function queryPointSpatialIndex(index, bounds) {
  const expandedBounds = expandBounds(bounds, POINT_EPSILON);
  const matches = [];
  const seen = new Set();
  forEachBucket(expandedBounds, (bucketKey) => {
    const bucket = index.get(bucketKey) || [];
    bucket.forEach((point) => {
      const key = pointKey(point);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      if (
        point.x >= expandedBounds.minX
        && point.x <= expandedBounds.maxX
        && point.y >= expandedBounds.minY
        && point.y <= expandedBounds.maxY
      ) {
        matches.push(point);
      }
    });
  });
  return matches;
}

function buildLotSplitGraph(polygon, clippedEdges) {
  const nodes = polygon.map((point) => clonePoint(point));
  const nodeByKey = new Map(nodes.map((point, index) => [pointKey(point), index]));
  const boundaryInsertionsByEdge = new Map();
  const internalEdges = [];

  clippedEdges.forEach((edge) => {
    const fromNodeId = getOrCreateGraphNode(nodes, nodeByKey, edge.from);
    const toNodeId = getOrCreateGraphNode(nodes, nodeByKey, edge.to);
    internalEdges.push({
      fromNodeId,
      toNodeId,
      river: true,
    });

    if (edge.fromBoundaryEdgeIndex !== null) {
      const points = boundaryInsertionsByEdge.get(edge.fromBoundaryEdgeIndex) || [];
      points.push({ nodeId: fromNodeId, point: clonePoint(nodes[fromNodeId]) });
      boundaryInsertionsByEdge.set(edge.fromBoundaryEdgeIndex, points);
    }
    if (edge.toBoundaryEdgeIndex !== null) {
      const points = boundaryInsertionsByEdge.get(edge.toBoundaryEdgeIndex) || [];
      points.push({ nodeId: toNodeId, point: clonePoint(nodes[toNodeId]) });
      boundaryInsertionsByEdge.set(edge.toBoundaryEdgeIndex, points);
    }
  });

  const boundaryOrder = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const startNodeId = getOrCreateGraphNode(nodes, nodeByKey, polygon[index]);
    boundaryOrder.push(startNodeId);

    const insertions = (boundaryInsertionsByEdge.get(index) || [])
      .filter((entry) => entry.nodeId !== startNodeId)
      .filter((entry) => entry.nodeId !== getOrCreateGraphNode(nodes, nodeByKey, polygon[(index + 1) % polygon.length]))
      .sort((first, second) => {
        const start = polygon[index];
        return pointDistance(start, first.point) - pointDistance(start, second.point);
      });

    insertions.forEach((entry) => {
      if (boundaryOrder[boundaryOrder.length - 1] !== entry.nodeId) {
        boundaryOrder.push(entry.nodeId);
      }
    });
  }

  const undirectedEdges = [];
  for (let index = 0; index < boundaryOrder.length; index += 1) {
    const fromNodeId = boundaryOrder[index];
    const toNodeId = boundaryOrder[(index + 1) % boundaryOrder.length];
    if (fromNodeId !== toNodeId) {
      undirectedEdges.push({ fromNodeId, toNodeId, river: false });
    }
  }
  internalEdges.forEach((edge) => {
    if (edge.fromNodeId !== edge.toNodeId) {
      undirectedEdges.push(edge);
    }
  });

  const directedEdges = [];
  const outgoingByNode = new Map();

  undirectedEdges.forEach((edge, index) => {
    const forwardId = directedEdges.length;
    const backwardId = directedEdges.length + 1;
    const forward = createDirectedEdge(nodes, edge.fromNodeId, edge.toNodeId, backwardId, edge.river, index);
    const backward = createDirectedEdge(nodes, edge.toNodeId, edge.fromNodeId, forwardId, edge.river, index);
    directedEdges.push(forward, backward);
    pushOutgoing(outgoingByNode, edge.fromNodeId, forwardId);
    pushOutgoing(outgoingByNode, edge.toNodeId, backwardId);
  });

  outgoingByNode.forEach((edgeIds) => {
    edgeIds.sort((firstId, secondId) => directedEdges[firstId].angle - directedEdges[secondId].angle);
  });

  directedEdges.forEach((edge) => {
    const outgoing = outgoingByNode.get(edge.toNodeId) || [];
    const reverseIndex = outgoing.indexOf(edge.twinId);
    const nextIndex = reverseIndex <= 0 ? outgoing.length - 1 : reverseIndex - 1;
    edge.nextFaceEdgeId = outgoing[nextIndex];
  });

  return {
    nodes,
    directedEdges,
  };
}

function traceGraphFaces(graph) {
  const faces = [];

  graph.directedEdges.forEach((edge, edgeId) => {
    if (edge.visited) {
      return;
    }

    const cycle = [];
    let cursorId = edgeId;
    while (cursorId !== null && cursorId !== undefined && !graph.directedEdges[cursorId].visited) {
      const cursor = graph.directedEdges[cursorId];
      cursor.visited = true;
      cycle.push(cursor.fromNodeId);
      cursorId = cursor.nextFaceEdgeId;
      if (cursorId === edgeId) {
        break;
      }
    }

    if (cycle.length >= 3) {
      const polygon = cycle.map((nodeId) => graph.nodes[nodeId]);
      if (computeSignedArea(polygon) > EPSILON) {
        faces.push(cycle);
      }
    }
  });

  return faces;
}

function rebuildSegmentsFromLots(lots, riverGraph) {
  const synchronizedLots = synchronizeLotBoundaryVertices(lots);
  const normalizedLots = synchronizedLots.map((lot) => ({
    ...lot,
    polygon: normalizePolygon(lot.polygon),
    centroid: computePolygonCentroid(normalizePolygon(lot.polygon)),
    segmentIds: [],
    neighborLotIds: [],
  }));
  const lotById = new Map(normalizedLots.map((lot) => [lot.id, lot]));
  const riverEdgeKeys = new Set(riverGraph.segments.flatMap((segment) => [
    edgeKey(segment.from, segment.to),
    edgeKey(segment.to, segment.from),
  ]));
  const riverSpatialIndex = buildSegmentSpatialIndex(riverGraph.segments);
  const rawSegmentMap = new Map();

  normalizedLots.forEach((lot) => {
    for (let index = 0; index < lot.polygon.length; index += 1) {
      const from = lot.polygon[index];
      const to = lot.polygon[(index + 1) % lot.polygon.length];
      const canonical = canonicalEdge(from, to);
      const key = edgeKey(canonical.from, canonical.to);
      const isRiver = spanIsRiver(from, to, riverEdgeKeys, riverSpatialIndex);
      const existing = rawSegmentMap.get(key);
      if (!existing) {
        const side = pointSide(canonical.from, canonical.to, lot.centroid);
        rawSegmentMap.set(key, {
          id: null,
          from: canonical.from,
          to: canonical.to,
          midpoint: midpointBetween(canonical.from, canonical.to),
          length: pointDistance(canonical.from, canonical.to),
          leftLotId: side >= 0 ? lot.id : null,
          rightLotId: side < 0 ? lot.id : null,
          features: {
            boundary: false,
            coast: false,
            land: false,
            sea: false,
            river: isRiver,
            riverside: isRiver,
          },
        });
        continue;
      }

      existing.features.river = existing.features.river || isRiver;
      existing.features.riverside = existing.features.riverside || isRiver;
      const side = pointSide(existing.from, existing.to, lot.centroid);
      if (side >= 0) {
        existing.leftLotId = lot.id;
      } else {
        existing.rightLotId = lot.id;
      }
    }
  });

  const segments = [];
  Array.from(rawSegmentMap.values()).forEach((segment) => {
    const features = {
      ...segment.features,
      boundary: segment.leftLotId === null || segment.rightLotId === null,
      ...buildSegmentSurfaceFeatures(segment, lotById),
    };
    const preserveAsIs = features.river || features.coast || features.sea;
    const sampledPoints = preserveAsIs
      ? [segment.from, segment.to]
      : resampleSpan(segment.from, segment.to, DEFAULT_SEGMENT_LENGTH * 2);

    for (let index = 0; index < sampledPoints.length - 1; index += 1) {
      const from = sampledPoints[index];
      const to = sampledPoints[index + 1];
      segments.push({
        ...segment,
        id: `segment:${segments.length}`,
        from,
        to,
        midpoint: midpointBetween(from, to),
        length: pointDistance(from, to),
        features,
      });
    }
  });

  segments.forEach((segment) => {
    if (segment.leftLotId !== null) {
      lotById.get(segment.leftLotId)?.segmentIds.push(segment.id);
    }
    if (segment.rightLotId !== null && segment.rightLotId !== segment.leftLotId) {
      lotById.get(segment.rightLotId)?.segmentIds.push(segment.id);
    }
    if (
      segment.leftLotId !== null
      && segment.rightLotId !== null
      && segment.leftLotId !== segment.rightLotId
    ) {
      const leftLot = lotById.get(segment.leftLotId);
      const rightLot = lotById.get(segment.rightLotId);
      if (leftLot && !leftLot.neighborLotIds.includes(segment.rightLotId)) {
        leftLot.neighborLotIds.push(segment.rightLotId);
      }
      if (rightLot && !rightLot.neighborLotIds.includes(segment.leftLotId)) {
        rightLot.neighborLotIds.push(segment.leftLotId);
      }
    }
  });

  normalizedLots.forEach((lot) => {
    lot.neighborLotIds.sort((first, second) => first - second);
  });

  const vertices = rebuildLotVertices(normalizedLots, segments);

  return {
    vertices,
    lots: normalizedLots,
    segments,
  };
}

function buildSegmentSurfaceFeatures(segment, lotById) {
  const leftLot = segment.leftLotId === null ? null : lotById.get(segment.leftLotId);
  const rightLot = segment.rightLotId === null ? null : lotById.get(segment.rightLotId);
  const leftSea = Boolean(leftLot?.features.sea);
  const rightSea = Boolean(rightLot?.features.sea);
  const hasSea = Boolean(leftSea || rightSea);
  const hasLand = Boolean(leftLot?.features.land || rightLot?.features.land);
  const coast = Boolean(hasSea && hasLand && leftSea !== rightSea);

  return {
    coast,
    land: hasLand && !coast,
    sea: Boolean(leftSea && rightSea),
    riverside: Boolean(segment.features.river),
  };
}

function spanIsRiver(from, to, riverEdgeKeys, riverSpatialIndex) {
  if (riverEdgeKeys.has(edgeKey(from, to)) || riverEdgeKeys.has(edgeKey(to, from))) {
    return true;
  }

  const bounds = expandBounds(computeBounds([from, to]), RIVER_SPAN_EPSILON);
  return querySpatialIndex(riverSpatialIndex, bounds).some((riverSegment) => spanLiesOnRiverSegment(from, to, riverSegment));
}

function spanLiesOnRiverSegment(from, to, riverSegment) {
  if (pointDistance(from, to) <= EPSILON) {
    return false;
  }

  const midpoint = midpointBetween(from, to);
  return pointLiesOnSegmentInclusive(from, riverSegment.from, riverSegment.to, RIVER_SPAN_EPSILON)
    && pointLiesOnSegmentInclusive(to, riverSegment.from, riverSegment.to, RIVER_SPAN_EPSILON)
    && pointDistanceToSegment(midpoint, riverSegment.from, riverSegment.to) <= RIVER_SPAN_EPSILON;
}

function pointLiesOnSegmentInclusive(point, from, to, epsilon = GRAPH_NODE_EPSILON) {
  const segmentLength = pointDistance(from, to);
  if (segmentLength <= EPSILON) {
    return pointDistance(point, from) <= epsilon;
  }

  const along = pointProjectionParameter(point, from, to);
  return along >= -epsilon / segmentLength
    && along <= 1 + (epsilon / segmentLength)
    && pointDistanceToSegment(point, from, to) <= epsilon;
}

function pointProjectionParameter(point, from, to) {
  const segmentLength = pointDistance(from, to);
  if (segmentLength <= EPSILON) {
    return 0;
  }

  return ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / (segmentLength ** 2);
}

function rebuildLotVertices(lots, segments) {
  const vertices = [];
  const vertexByKey = new Map();
  lots.forEach((lot) => {
    lot.vertexIds = lot.polygon.map((point) => getOrCreateLotVertex(vertices, vertexByKey, point));
  });

  segments.forEach((segment) => {
    segment.fromVertexId = getOrCreateLotVertex(vertices, vertexByKey, segment.from);
    segment.toVertexId = getOrCreateLotVertex(vertices, vertexByKey, segment.to);
    vertices[segment.fromVertexId].segmentIds.push(segment.id);
    vertices[segment.toVertexId].segmentIds.push(segment.id);
  });

  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  vertices.forEach((vertex) => {
    const featureList = vertex.segmentIds.map((segmentId) => segmentById.get(segmentId)?.features).filter(Boolean);
    vertex.features = {
      coast: featureList.some((features) => features.coast),
      land: featureList.some((features) => features.land || features.coast),
      sea: featureList.some((features) => features.sea),
      riverside: featureList.some((features) => features.riverside),
    };
  });

  return vertices;
}

function getOrCreateLotVertex(vertices, vertexByKey, point) {
  const key = pointKey(point);
  const existingId = vertexByKey.get(key);
  if (existingId !== undefined) {
    return existingId;
  }

  const id = vertices.length;
  vertices.push({
    id,
    x: point.x,
    y: point.y,
    segmentIds: [],
    features: {
      coast: false,
      land: false,
      sea: false,
      riverside: false,
    },
  });
  vertexByKey.set(key, id);
  return id;
}

function synchronizeLotBoundaryVertices(lots) {
  const allPoints = [];
  const seen = new Set();

  lots.forEach((lot) => {
    lot.polygon.forEach((point) => {
      const key = pointKey(point);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      allPoints.push(clonePoint(point));
    });
  });

  const pointIndex = buildPointSpatialIndex(allPoints);

  return lots.map((lot) => ({
    ...lot,
    polygon: insertSharedBoundaryVertices(lot.polygon, pointIndex),
  }));
}

function insertSharedBoundaryVertices(polygon, pointIndex) {
  const normalized = normalizePolygon(polygon);
  const expanded = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const from = normalized[index];
    const to = normalized[(index + 1) % normalized.length];
    expanded.push(clonePoint(from));

    const insertions = queryPointSpatialIndex(pointIndex, computeBounds([from, to]))
      .filter((point) => !pointsMatch(point, from) && !pointsMatch(point, to))
      .filter((point) => pointLiesOnSegment(point, from, to))
      .sort((first, second) => pointDistance(from, first) - pointDistance(from, second));

    insertions.forEach((point) => {
      const previous = expanded[expanded.length - 1];
      if (!pointsMatch(previous, point)) {
        expanded.push(clonePoint(point));
      }
    });
  }

  return normalizePolygon(expanded);
}

function createSplitLot(lot, polygon, id) {
  return {
    ...lot,
    id,
    centroid: computePolygonCentroid(polygon),
    polygon,
    segmentIds: [],
    neighborLotIds: [],
  };
}

function clipRiverSegmentToConvexPolygon(segment, polygon) {
  const parameters = [0, 1];
  const boundaryHits = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const boundaryFrom = polygon[index];
    const boundaryTo = polygon[(index + 1) % polygon.length];
    const hit = segmentIntersection(segment.from, segment.to, boundaryFrom, boundaryTo);
    if (!hit) {
      continue;
    }

    parameters.push(hit.t);
    boundaryHits.push({
      t: hit.t,
      edgeIndex: index,
      point: hit.point,
    });
  }

  if (pointInConvexPolygon(segment.from, polygon)) {
    parameters.push(0);
  }
  if (pointInConvexPolygon(segment.to, polygon)) {
    parameters.push(1);
  }

  const sortedParameters = uniqueSortedNumbers(parameters);
  if (sortedParameters.length < 2) {
    return null;
  }

  for (let index = 0; index < sortedParameters.length - 1; index += 1) {
    const startT = sortedParameters[index];
    const endT = sortedParameters[index + 1];
    if (endT - startT < EPSILON) {
      continue;
    }

    const midpoint = pointAlongSegment(segment.from, segment.to, (startT + endT) / 2);
    if (!pointInConvexPolygon(midpoint, polygon)) {
      continue;
    }

    const fromPoint = pointAlongSegment(segment.from, segment.to, startT);
    const toPoint = pointAlongSegment(segment.from, segment.to, endT);

    return {
      from: fromPoint,
      to: toPoint,
      fromBoundaryEdgeIndex: findBoundaryEdgeIndex(boundaryHits, startT),
      toBoundaryEdgeIndex: findBoundaryEdgeIndex(boundaryHits, endT),
      segmentId: segment.id,
    };
  }

  return null;
}

function resampleSpan(from, to, targetLength = DEFAULT_SEGMENT_LENGTH) {
  const spanLength = pointDistance(from, to);
  const segmentCount = Math.max(1, Math.ceil(spanLength / targetLength));
  return resamplePolyline([from, to], segmentCount);
}

function resolveRiverBranchType(river, samplePosition, mergeIndex, branchType) {
  if (branchType === "tributary") {
    return "tributary";
  }

  if (mergeIndex === null) {
    return "primary";
  }

  return samplePosition < mergeIndex ? "primary_upstream" : "primary_downstream";
}

function findPrimaryMergePointIndex(river) {
  if (river.widthMergeCellId === null || river.widthMergeCellId === undefined) {
    return null;
  }

  return findPrimaryMergePointIndexForCell(river, river.widthMergeCellId);
}

function findPrimaryMergePointIndexForCell(river, cellId) {
  if (cellId === null || cellId === undefined) {
    return null;
  }

  const cellIndex = river.cellIds?.indexOf(cellId) ?? -1;
  if (cellIndex < 0) {
    return null;
  }

  return 1 + (cellIndex * 2);
}

function dedupeRiverSegments(segments) {
  const seen = new Set();
  return segments.filter((segment) => {
    const key = edgeKey(segment.from, segment.to);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function createDirectedEdge(nodes, fromNodeId, toNodeId, twinId, river, undirectedId) {
  const from = nodes[fromNodeId];
  const to = nodes[toNodeId];
  return {
    fromNodeId,
    toNodeId,
    twinId,
    undirectedId,
    river,
    angle: Math.atan2(to.y - from.y, to.x - from.x),
    nextFaceEdgeId: null,
    visited: false,
  };
}

function pushOutgoing(outgoingByNode, nodeId, edgeId) {
  const existing = outgoingByNode.get(nodeId) || [];
  existing.push(edgeId);
  outgoingByNode.set(nodeId, existing);
}

function getOrCreateNode(nodes, nodeByKey, point) {
  const key = pointKey(point);
  const existing = nodeByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const nodeId = nodes.length;
  nodes.push(clonePoint(point));
  nodeByKey.set(key, nodeId);
  return nodeId;
}

function getOrCreateGraphNode(nodes, nodeByKey, point) {
  const keyed = nodeByKey.get(pointKey(point));
  if (keyed !== undefined) {
    return keyed;
  }

  const existing = findMatchingNode(nodes, point, GRAPH_NODE_EPSILON);
  if (existing !== -1) {
    return existing;
  }

  const nodeId = nodes.length;
  nodes.push(clonePoint(point));
  nodeByKey.set(pointKey(point), nodeId);
  return nodeId;
}

function findMatchingNode(nodes, point, epsilon = POINT_EPSILON) {
  for (let index = 0; index < nodes.length; index += 1) {
    if (pointsMatch(nodes[index], point, epsilon)) {
      return index;
    }
  }

  return -1;
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}

function edgeKey(from, to) {
  return `${pointKey(from)}|${pointKey(to)}`;
}

function canonicalEdge(from, to) {
  if (from.x < to.x || (Math.abs(from.x - to.x) <= EPSILON && from.y <= to.y)) {
    return {
      from: clonePoint(from),
      to: clonePoint(to),
    };
  }

  return {
    from: clonePoint(to),
    to: clonePoint(from),
  };
}

function pointLiesOnSegment(point, from, to) {
  const segmentLength = pointDistance(from, to);
  if (segmentLength <= EPSILON) {
    return false;
  }

  const offset = Math.abs(pointSide(from, to, point));
  if (offset > EPSILON) {
    return false;
  }

  const along = ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / (segmentLength ** 2);
  return along > EPSILON && along < 1 - EPSILON;
}

function normalizePolygon(points) {
  const normalized = dedupeConsecutivePoints(points.map((point) => clonePoint(point)));
  if (normalized.length > 1 && pointsMatch(normalized[0], normalized[normalized.length - 1])) {
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

function boundsOverlap(first, second) {
  return !(
    first.maxX < second.minX
    || first.minX > second.maxX
    || first.maxY < second.minY
    || first.minY > second.maxY
  );
}

function forEachBucket(bounds, callback) {
  const minBucketX = Math.floor(bounds.minX / SPATIAL_BUCKET_SIZE);
  const maxBucketX = Math.floor(bounds.maxX / SPATIAL_BUCKET_SIZE);
  const minBucketY = Math.floor(bounds.minY / SPATIAL_BUCKET_SIZE);
  const maxBucketY = Math.floor(bounds.maxY / SPATIAL_BUCKET_SIZE);

  for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX += 1) {
    for (let bucketY = minBucketY; bucketY <= maxBucketY; bucketY += 1) {
      callback(`${bucketX},${bucketY}`);
    }
  }
}

function spatialBucketKey(x, y) {
  return `${Math.floor(x / SPATIAL_BUCKET_SIZE)},${Math.floor(y / SPATIAL_BUCKET_SIZE)}`;
}

function pointInConvexPolygon(point, polygon) {
  let hasPositive = false;
  let hasNegative = false;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const side = pointSide(current, next, point);
    if (side > POINT_EPSILON) {
      hasPositive = true;
    } else if (side < -POINT_EPSILON) {
      hasNegative = true;
    }

    if (hasPositive && hasNegative) {
      return false;
    }
  }

  return true;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const last = polygon[previous];
    const intersects = ((current.y > point.y) !== (last.y > point.y))
      && (point.x < ((last.x - current.x) * (point.y - current.y)) / ((last.y - current.y) || EPSILON) + current.x);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonsMatch(first, second) {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((point) => second.some((candidate) => pointsMatch(point, candidate)));
}

function pointSide(from, to, point) {
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

function pointAlongSegment(from, to, t) {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  };
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.map((value) => Number(value.toFixed(6))))].sort((first, second) => first - second);
}

function findBoundaryEdgeIndex(boundaryHits, parameter) {
  const match = boundaryHits.find((hit) => Math.abs(hit.t - parameter) <= 0.0005);
  return match ? match.edgeIndex : null;
}

function segmentIntersection(firstFrom, firstTo, secondFrom, secondTo) {
  const firstVector = {
    x: firstTo.x - firstFrom.x,
    y: firstTo.y - firstFrom.y,
  };
  const secondVector = {
    x: secondTo.x - secondFrom.x,
    y: secondTo.y - secondFrom.y,
  };
  const denominator = cross(firstVector, secondVector);
  if (Math.abs(denominator) < EPSILON) {
    return null;
  }

  const offset = {
    x: secondFrom.x - firstFrom.x,
    y: secondFrom.y - firstFrom.y,
  };
  const t = cross(offset, secondVector) / denominator;
  const u = cross(offset, firstVector) / denominator;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) {
    return null;
  }

  return {
    t: Math.min(1, Math.max(0, t)),
    point: pointAlongSegment(firstFrom, firstTo, t),
  };
}

function pointsMatch(first, second, epsilon = POINT_EPSILON) {
  return pointDistance(first, second) <= epsilon;
}
