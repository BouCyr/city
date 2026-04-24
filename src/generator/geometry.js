/*
 * WHAT: Share low-level geometry and numeric helpers across generation steps.
 * HOW: Export small pure functions for clamping, distance, vector math, and side tests.
 * WHY: Step modules should stay focused on generation logic instead of re-declaring common math.
 */

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function distanceToSide(point, size, side) {
  if (side === "north") return point.y;
  if (side === "south") return size - point.y;
  if (side === "west") return point.x;
  return size - point.x;
}

export function centerBias(point, size, radiusRatio = 0.68) {
  const dx = point.x - size / 2;
  const dy = point.y - size / 2;
  const distance = Math.hypot(dx, dy);
  return Math.max(0, 1 - distance / (size * radiusRatio));
}

export function cross(first, second) {
  return first.x * second.y - first.y * second.x;
}
