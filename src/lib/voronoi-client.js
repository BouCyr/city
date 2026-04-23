/*
 * WHAT: Wrap d3-delaunay so the generator receives a cleaned Voronoi graph instead of raw library objects.
 * HOW: Build clipped cell polygons, centroids, neighbor lists, and shared-edge records from the Delaunay output.
 * WHY: The generator and renderer need a stable geometry format that is easy to reason about and replay.
 */

import { Delaunay } from "https://cdn.jsdelivr.net/npm/d3-delaunay@6/+esm";

const VORONOI_BOUNDS_MIN = 0;
const DEGENERATE_AREA_EPSILON = 0.0001;
const BOUNDARY_TOUCH_THRESHOLD = 0.5;
const POINT_DEDUPE_DISTANCE_SQUARED = 0.01;
const SEGMENT_MATCH_EPSILON = 0.75;
const SEGMENT_BUCKET_PRECISION_DIGITS = 1;

/**
 * WHAT: Convert a point cloud into cells and shared edges clipped to the map bounds.
 * HOW: Ask d3-delaunay for the Voronoi diagram, then normalize the output into plain serializable objects.
 * WHY: Later generation steps need deterministic geometry they can annotate with water, center, and river metadata.
 */
export function buildVoronoiDiagram({ points, width, height }) {
  const coordinates = points.map((point) => [point.x, point.y]);
  const delaunay = Delaunay.from(coordinates);
  const voronoi = delaunay.voronoi([VORONOI_BOUNDS_MIN, VORONOI_BOUNDS_MIN, width, height]);

  const cells = points.map((point, index) => {
    const polygon = sanitizePolygon(voronoi.cellPolygon(index));
    const neighbors = Array.from(delaunay.neighbors(index));
    const centroid = polygon.length > 0 ? computeCentroid(polygon) : { x: point.x, y: point.y };
    return {
      id: index,
      site: point,
      polygon,
      centroid,
      neighbors,
      touches: detectTouches(polygon, width, height),
      isSea: false,
    };
  });

  const edges = collectEdges(cells);

  return { cells, edges };
}

function sanitizePolygon(polygon) {
  if (!polygon) {
    return [];
  }

  const cleaned = polygon.slice(0, -1).map(([x, y]) => ({ x, y }));
  return dedupePoints(cleaned);
}

function dedupePoints(points) {
  const result = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || distanceSquared(previous, point) > POINT_DEDUPE_DISTANCE_SQUARED) {
      result.push(point);
    }
  }
  return result;
}

function computeCentroid(polygon) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }

  if (Math.abs(twiceArea) < DEGENERATE_AREA_EPSILON) {
    return polygon[0] || { x: 0, y: 0 };
  }

  return {
    x: x / (3 * twiceArea),
    y: y / (3 * twiceArea),
  };
}

function detectTouches(polygon, width, height) {
  return {
    north: polygon.some((point) => point.y <= BOUNDARY_TOUCH_THRESHOLD),
    south: polygon.some((point) => point.y >= height - BOUNDARY_TOUCH_THRESHOLD),
    west: polygon.some((point) => point.x <= BOUNDARY_TOUCH_THRESHOLD),
    east: polygon.some((point) => point.x >= width - BOUNDARY_TOUCH_THRESHOLD),
  };
}

function collectEdges(cells) {
  const segmentBuckets = new Map();
  const edges = [];

  for (const cell of cells) {
    for (let index = 0; index < cell.polygon.length; index += 1) {
      const from = cell.polygon[index];
      const to = cell.polygon[(index + 1) % cell.polygon.length];
      const candidate = {
        a: cell.id,
        from,
        to,
      };
      const key = segmentBucketKey(from, to);
      const bucket = segmentBuckets.get(key) || [];
      const matchIndex = bucket.findIndex((segment) => segmentsMatch(segment, candidate));

      if (matchIndex >= 0) {
        const existing = bucket.splice(matchIndex, 1)[0];
        edges.push({
          id: `${existing.a}-${cell.id}-${key}`,
          a: existing.a,
          b: cell.id,
          from: existing.from,
          to: existing.to,
          kind: "land",
        });
      } else {
        bucket.push(candidate);
        segmentBuckets.set(key, bucket);
      }
    }
  }

  for (const [key, bucket] of segmentBuckets) {
    for (const segment of bucket) {
      edges.push({
        id: `boundary-${segment.a}-${key}`,
        a: segment.a,
        b: null,
        from: segment.from,
        to: segment.to,
        kind: "land",
      });
    }
  }

  return edges;
}

function segmentBucketKey(from, to) {
  const midpoint = {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return `${normalizeScalar(midpoint.x)}:${normalizeScalar(midpoint.y)}:${normalizeScalar(length)}`;
}

function segmentsMatch(first, second) {
  return (
    pointsNear(first.from, second.from) && pointsNear(first.to, second.to)
  ) || (
    pointsNear(first.from, second.to) && pointsNear(first.to, second.from)
  );
}

function pointsNear(first, second, epsilon = SEGMENT_MATCH_EPSILON) {
  return distanceSquared(first, second) <= epsilon ** 2;
}

function normalizeScalar(value) {
  return value.toFixed(SEGMENT_BUCKET_PRECISION_DIGITS);
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
