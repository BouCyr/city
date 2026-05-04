/*
 * WHAT: Build the straight bisection split path for lot tessellation.
 * HOW: Resample the chord between the two boundary points, or return the endpoints when no resampling is requested.
 * WHY: Straight bisection stays isolated so step-level dispatch can swap algorithms without embedding them in one file.
 */

import { clonePoint, pointDistance } from "../map-model.js";

export function buildStraightBisectionSplitPath(start, end, targetLength) {
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
