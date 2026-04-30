/*
 * WHAT: Build the curved bisection split path for lot tessellation.
 * HOW: Construct the circle tangent to the two endpoint normals, then sample the arc inside the lot.
 * WHY: Curved bisection should follow the actual tangent circle instead of an approximated spline.
 */

import { clonePoint, pointDistance } from "../map-model.js";

const EPSILON = 0.0001;
const CURVE_SAMPLING_STEPS = 24;

export function buildCurvedBisectionSplitPath(points, firstIndex, secondIndex, targetLength, curveAmplitude, normalGuides) {
  const start = points[firstIndex];
  const end = points[secondIndex];
  const chordLength = pointDistance(start, end);
  const polygonCentroid = computePolygonCentroid(points);
  const guideLength = chordLength * curveAmplitude;
  const startDirection = computeInteriorBisectorDirection(points, firstIndex, polygonCentroid);
  const endDirection = computeInteriorBisectorDirection(points, secondIndex, polygonCentroid);

  if (Array.isArray(normalGuides)) {
    normalGuides.push({
      from: clonePoint(start),
      to: {
        x: start.x + (startDirection.x * guideLength),
        y: start.y + (startDirection.y * guideLength),
      },
    });
    normalGuides.push({
      from: clonePoint(end),
      to: {
        x: end.x + (endDirection.x * guideLength),
        y: end.y + (endDirection.y * guideLength),
      },
    });
  }

  const arc = buildTangentArc(start, end, startDirection, endDirection);
  if (!arc) {
    return buildStraightFallback(start, end, targetLength);
  }

  const sampled = sampleArc(arc, CURVE_SAMPLING_STEPS);
  const curveLength = Math.abs(arc.radius * arc.deltaAngle);
  const segmentCount = Math.max(1, Math.round(curveLength / Math.max(EPSILON, targetLength)));
  return resamplePolyline(sampled, segmentCount);
}

export function inspectCurvedBisection(points, firstIndex, secondIndex, targetLength, curveAmplitude) {
  const start = points[firstIndex];
  const end = points[secondIndex];
  const chordLength = pointDistance(start, end);
  const polygonCentroid = computePolygonCentroid(points);
  const guideLength = chordLength * curveAmplitude;
  const startDirection = computeInteriorBisectorDirection(points, firstIndex, polygonCentroid);
  const endDirection = computeInteriorBisectorDirection(points, secondIndex, polygonCentroid);
  const arc = buildTangentArc(start, end, startDirection, endDirection);
  const path = arc
    ? resamplePolyline(sampleArc(arc, CURVE_SAMPLING_STEPS), Math.max(1, Math.round(Math.abs(arc.radius * arc.deltaAngle) / Math.max(EPSILON, targetLength))))
    : buildStraightFallback(start, end, targetLength);

  return {
    start: clonePoint(start),
    end: clonePoint(end),
    startDirection,
    endDirection,
    guideLength,
    arc,
    path,
    fallbackReason: arc ? null : "The endpoint tangents are parallel or do not define a stable tangent circle, so this bisection falls back to a straight split.",
  };
}

function buildStraightFallback(start, end, targetLength) {
  if (!targetLength) {
    return [clonePoint(start), clonePoint(end)];
  }

  const length = pointDistance(start, end);
  const segmentCount = Math.max(1, Math.round(length / targetLength));
  const points = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const t = index / segmentCount;
    points.push({
      x: start.x + ((end.x - start.x) * t),
      y: start.y + ((end.y - start.y) * t),
    });
  }
  return points;
}

function computeInteriorBisectorDirection(points, index, interiorTarget = null) {
  const current = points[index];
  const previous = points[(index - 1 + points.length) % points.length];
  const next = points[(index + 1) % points.length];
  const toPrevious = normalizeVector({
    x: previous.x - current.x,
    y: previous.y - current.y,
  });
  const toNext = normalizeVector({
    x: next.x - current.x,
    y: next.y - current.y,
  });
  const bisector = normalizeVector({
    x: toPrevious.x + toNext.x,
    y: toPrevious.y + toNext.y,
  });
  if (vectorLength(bisector) > EPSILON) {
    return orientDirectionTowardInterior(current, bisector, interiorTarget);
  }

  const previousNormal = normalizeVector(leftNormal({
    x: current.x - previous.x,
    y: current.y - previous.y,
  }));
  const nextNormal = normalizeVector(leftNormal({
    x: next.x - current.x,
    y: next.y - current.y,
  }));
  const normalBisector = normalizeVector({
    x: previousNormal.x + nextNormal.x,
    y: previousNormal.y + nextNormal.y,
  });
  if (vectorLength(normalBisector) > EPSILON) {
    return orientDirectionTowardInterior(current, normalBisector, interiorTarget);
  }
  return orientDirectionTowardInterior(current, { x: 0, y: -1 }, interiorTarget);
}

function orientDirectionTowardInterior(origin, direction, interiorTarget) {
  if (!interiorTarget) {
    return direction;
  }

  const towardInterior = {
    x: interiorTarget.x - origin.x,
    y: interiorTarget.y - origin.y,
  };
  if (((direction.x * towardInterior.x) + (direction.y * towardInterior.y)) < 0) {
    return {
      x: -direction.x,
      y: -direction.y,
    };
  }
  return direction;
}

function buildTangentArc(start, end, startTangent, endTangent) {
  if (vectorLength(startTangent) <= EPSILON || vectorLength(endTangent) <= EPSILON) {
    return null;
  }

  const startNormal = leftNormal(startTangent);
  const endNormal = leftNormal(endTangent);
  const center = intersectLines(start, startNormal, end, endNormal);
  if (!center) {
    return null;
  }

  const radiusVectorStart = {
    x: start.x - center.x,
    y: start.y - center.y,
  };
  const radiusVectorEnd = {
    x: end.x - center.x,
    y: end.y - center.y,
  };
  const radius = vectorLength(radiusVectorStart);
  if (radius <= EPSILON || Math.abs(radius - vectorLength(radiusVectorEnd)) > EPSILON * Math.max(1, radius)) {
    return null;
  }

  const startAngle = Math.atan2(radiusVectorStart.y, radiusVectorStart.x);
  const endAngle = Math.atan2(radiusVectorEnd.y, radiusVectorEnd.x);
  const ccwTangent = normalizeVector(leftNormal(radiusVectorStart));
  const cwTangent = normalizeVector(scalePoint(ccwTangent, -1));
  const ccwScore = (ccwTangent.x * startTangent.x) + (ccwTangent.y * startTangent.y);
  const cwScore = (cwTangent.x * startTangent.x) + (cwTangent.y * startTangent.y);
  const orientation = ccwScore >= cwScore ? 1 : -1;
  const expectedEndTangent = orientation > 0
    ? normalizeVector(leftNormal(radiusVectorEnd))
    : normalizeVector(scalePoint(leftNormal(radiusVectorEnd), -1));
  const endAlignment = (expectedEndTangent.x * endTangent.x) + (expectedEndTangent.y * endTangent.y);
  if (endAlignment < 1 - (EPSILON * 16)) {
    return null;
  }

  const deltaAngle = orientation > 0
    ? normalizePositiveAngle(endAngle - startAngle)
    : -normalizePositiveAngle(startAngle - endAngle);
  if (Math.abs(deltaAngle) <= EPSILON) {
    return null;
  }

  return {
    center,
    radius,
    startAngle,
    deltaAngle,
  };
}

function sampleArc(arc, stepCount) {
  const points = [];
  for (let index = 0; index <= stepCount; index += 1) {
    const t = index / stepCount;
    const angle = arc.startAngle + (arc.deltaAngle * t);
    points.push({
      x: arc.center.x + (Math.cos(angle) * arc.radius),
      y: arc.center.y + (Math.sin(angle) * arc.radius),
    });
  }
  return points;
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

function normalizeVector(vector) {
  const length = vectorLength(vector);
  if (length <= EPSILON) {
    return { x: 0, y: 0 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function vectorLength(vector) {
  return Math.hypot(vector.x, vector.y);
}

function scalePoint(point, scalar) {
  return {
    x: point.x * scalar,
    y: point.y * scalar,
  };
}

function leftNormal(vector) {
  return {
    x: -vector.y,
    y: vector.x,
  };
}

function intersectLines(firstPoint, firstDirection, secondPoint, secondDirection) {
  const determinant = crossProduct(firstDirection, secondDirection);
  if (Math.abs(determinant) <= EPSILON) {
    return null;
  }

  const offset = {
    x: secondPoint.x - firstPoint.x,
    y: secondPoint.y - firstPoint.y,
  };
  const distanceAlongFirst = crossProduct(offset, secondDirection) / determinant;
  return {
    x: firstPoint.x + (firstDirection.x * distanceAlongFirst),
    y: firstPoint.y + (firstDirection.y * distanceAlongFirst),
  };
}

function normalizePositiveAngle(angle) {
  const turn = Math.PI * 2;
  let normalized = angle % turn;
  if (normalized < 0) {
    normalized += turn;
  }
  return normalized;
}

function crossProduct(first, second) {
  return (first.x * second.y) - (first.y * second.x);
}
