/*
 * WHAT: Smooth a polyline into sampled per-segment paths while preserving pinned points exactly.
 * HOW: Use midpoint-control quadratic Bezier spans around each polyline vertex, then split the sampled
 *      curve back onto the original consecutive segments.
 * WHY: Coast, river, and parish-border geometry all need the same sampled smoothing behavior.
 */

import {
  DEFAULT_SEGMENT_LENGTH,
  clonePoint,
  dedupeConsecutivePoints,
  midpointBetween,
  normalizePolyline,
  pointDistance,
  resamplePolyline,
} from "./map-model.js";

const EPSILON = 0.0001;
const POINT_KEY_DIGITS = 4;

export function smoothPinnedPolyline(points, pinnedPointKeys = new Set(), targetLength = DEFAULT_SEGMENT_LENGTH) {
  const segmentPaths = buildSmoothedSegmentPaths(points, pinnedPointKeys, targetLength);
  const smoothed = [];
  segmentPaths.forEach((path) => {
    appendPath(smoothed, path);
  });
  return dedupeConsecutivePoints(smoothed);
}

export function buildSmoothedSegmentPaths(points, pinnedPointKeys = new Set(), targetLength = DEFAULT_SEGMENT_LENGTH) {
  return inspectPinnedPolylineSmoothing(points, pinnedPointKeys, targetLength).segmentPaths;
}

export function inspectPinnedPolylineSmoothing(points, pinnedPointKeys = new Set(), targetLength = DEFAULT_SEGMENT_LENGTH) {
  const normalizedPoints = normalizePolyline(points);
  if (normalizedPoints.length < 2) {
    return {
      points: normalizedPoints,
      curves: [],
      segmentPaths: [],
      smoothedPath: [],
    };
  }

  if (normalizedPoints.length < 3) {
    const segmentPaths = normalizedPoints.slice(0, -1).map((point, index) =>
      sampleFallbackSegment(point, normalizedPoints[index + 1], targetLength)
    );
    return {
      points: normalizedPoints,
      curves: [],
      segmentPaths,
      smoothedPath: dedupeConsecutivePoints(segmentPaths.flat()),
    };
  }

  const segmentPaths = Array.from({ length: normalizedPoints.length - 1 }, () => ({
    fromToMidpoint: null,
    midpointToTo: null,
  }));
  const curves = [];

  for (let index = 0; index < normalizedPoints.length; index += 1) {
    const control = normalizedPoints[index];
    const previousMidpoint = index > 0 ? midpointBetween(normalizedPoints[index - 1], control) : null;
    const nextMidpoint = index < normalizedPoints.length - 1 ? midpointBetween(control, normalizedPoints[index + 1]) : null;
    const isPinned = index === 0 || index === normalizedPoints.length - 1 || pinnedPointKeys.has(pointKey(control));
    const start = previousMidpoint || mirrorPoint(nextMidpoint, control);
    const end = nextMidpoint || mirrorPoint(previousMidpoint, control);
    const curve = sampleQuadraticBezier(start, control, end, targetLength);
    const splitIndex = findClosestPointIndex(curve, control);
    const splitPoint = isPinned ? clonePoint(control) : clonePoint(curve[splitIndex]);
    curves.push({
      start,
      control,
      end,
      points: curve,
      splitPoint,
      splitIndex,
      isPinned,
    });

    if (index > 0) {
      segmentPaths[index - 1].midpointToTo = dedupeConsecutivePoints([
        ...curve.slice(0, splitIndex),
        splitPoint,
      ]);
    }
    if (index < normalizedPoints.length - 1) {
      segmentPaths[index].fromToMidpoint = dedupeConsecutivePoints([
        splitPoint,
        ...curve.slice(splitIndex + 1),
      ]);
    }
  }

  const resolvedSegmentPaths = segmentPaths.map((entry, index) => {
    const fallback = sampleFallbackSegment(normalizedPoints[index], normalizedPoints[index + 1], targetLength);
    return entry.fromToMidpoint && entry.midpointToTo
      ? dedupeConsecutivePoints([...entry.fromToMidpoint, ...entry.midpointToTo.slice(1)])
      : fallback;
  });

  return {
    points: normalizedPoints,
    curves,
    segmentPaths: resolvedSegmentPaths,
    smoothedPath: dedupeConsecutivePoints(resolvedSegmentPaths.flat()),
  };
}

function sampleFallbackSegment(from, to, targetLength) {
  return resamplePolyline([from, to], Math.max(1, Math.ceil(pointDistance(from, to) / targetLength)));
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

function mirrorPoint(point, origin) {
  return {
    x: (origin.x * 2) - point.x,
    y: (origin.y * 2) - point.y,
  };
}

function appendPath(target, path) {
  path.forEach((point) => {
    const previous = target[target.length - 1];
    if (!previous || pointDistance(previous, point) > EPSILON) {
      target.push(clonePoint(point));
    }
  });
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
