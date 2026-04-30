/*
 * WHAT: Build human-readable tutorial frames for the lot tessellation algorithms.
 * HOW: Reuse the same split path builders as step 1.11 while recording the intermediate geometry.
 * WHY: The illustration page should explain the real algorithm without duplicating renderer-only logic.
 */

import { Delaunay } from "../../lib/d3-delaunay/index.js";
import { clonePoint, pointDistance } from "../map-model.js";
import { createSeededRandom } from "../random.js";
import { inspectCurvedBisection } from "./1-11-curved-bisection.js";
import { splitLotPolygonRecursively } from "./1-11-tessellate-lots.js";

const EPSILON = 0.0001;
const POISSON_SPACING_RATIO = 0.95;
const POISSON_MAX_ATTEMPTS = 30;
const POISSON_CANDIDATE_ATTEMPTS = 120;
const POISSON_BBOX_PADDING = 0.001;
const EDGE_SEGMENT_LENGTH = 70;

export const TUTORIAL_LOT = {
  id: 436,
  polygon: [
    { x: 110, y: 210 },
    { x: 270, y: 130 },
    { x: 505, y: 105 },
    { x: 700, y: 190 },
    { x: 775, y: 360 },
    { x: 695, y: 535 },
    { x: 455, y: 650 },
    { x: 235, y: 600 },
    { x: 85, y: 420 },
  ],
};

const TUTORIAL_LOT_SEGMENTED = {
  id: TUTORIAL_LOT.id,
  polygon: splitPolygonEdgesIntoSegments(normalizePolygon(TUTORIAL_LOT.polygon), EDGE_SEGMENT_LENGTH),
};

export function buildBisectionTutorialTrace({
  algorithm = "straight_bisection",
  lot = TUTORIAL_LOT,
  segmentLength = 135,
  curveAmplitude = 0.35,
  seed = "bissection-demo",
} = {}) {
  const originalPolygon = normalizePolygon(lot.polygon);
  const polygon = splitPolygonEdgesIntoSegments(originalPolygon, EDGE_SEGMENT_LENGTH);
  const frames = [
    frame("Original fixed lot", "The tutorial starts from one fixed lot. It is drawn as one polygon before the bisection code prepares its working vertices.", {
      basePolygon: originalPolygon,
      polygons: [{ points: originalPolygon, className: "tutorial-active-area" }],
      points: labelVertices(originalPolygon),
    }),
    frame("Split edges into working segments", `Long lot edges are split into shorter boundary segments first. The bisection algorithms work from these ${polygon.length} boundary vertices.`, {
      basePolygon: originalPolygon,
      polygons: [{ points: polygon, className: "tutorial-active-area segmented-lot" }],
      points: labelVertices(polygon),
    }),
  ];

  if (algorithm === "poisson_voronoi") {
    return {
      lot,
      algorithm,
      frames: buildPoissonTrace({ polygon, segmentLength, seed, frames }),
    };
  }

  const leaves = splitLotPolygonRecursively(polygon, segmentLength, algorithm, curveAmplitude, [], (event) => {
    appendBisectionEventFrame(frames, event, algorithm, curveAmplitude, segmentLength);
  });

  frames.push(frame("Finished bisection tree", `The recursion stops with ${leaves.length} leaf sublots. Each remaining polygon is too small to split safely or has no valid balanced split left.`, {
    basePolygon: polygon,
    polygons: leaves.map((points, index) => ({ points, className: `tutorial-piece piece-${index % 6}` })),
  }));

  return { lot, algorithm, frames };
}

function appendBisectionEventFrame(frames, event, algorithm, curveAmplitude, segmentLength) {
  const common = {
    basePolygon: TUTORIAL_LOT_SEGMENTED.polygon,
    activePolygon: event.polygon,
    partition: buildPartitionLayers(event.partition || [event.polygon], event.polygon),
    polygons: [{ points: event.polygon, className: "tutorial-active-area" }],
  };

  if (event.type === "leaf") {
    frames.push(frame(`Leaf at depth ${event.depth}`, `This polygon is kept as a final sublot because its area is ${event.area.toFixed(0)}, below the recursive split threshold of ${event.minimumLeafArea.toFixed(0)}.`, common));
    return;
  }

  if (event.type === "candidates") {
    frames.push(frame(`Choose vertices at depth ${event.depth}`, `The real tessellation code checks non-adjacent, unblocked vertex pairs. ${event.candidates.length} pairs keep both child areas above 40% of the current lot area.`, {
      ...common,
      points: labelVertices(event.polygon, event.blockedVertexKeys),
      candidateLines: event.candidates.slice(0, 10).map((candidate) => ({
        from: event.polygon[candidate.firstIndex],
        to: event.polygon[candidate.secondIndex],
        className: "candidate-line",
      })),
    }));
    return;
  }

  if (event.type === "no-split") {
    frames.push(frame(`No split at depth ${event.depth}`, "No candidate pair satisfies the same balance rule used by the main map, so this polygon becomes a final sublot.", common));
    return;
  }

  if (event.type === "selected") {
    frames.push(frame(`Selected vertices ${event.split.firstIndex} and ${event.split.secondIndex}`, `The main tessellation code chooses the shortest valid pair. Its chord length is ${event.split.length.toFixed(1)}, and the child area difference is ${event.split.balanceGap.toFixed(0)}.`, {
      ...common,
      points: labelVertices(event.polygon),
      selectedLine: { from: event.polygon[event.split.firstIndex], to: event.polygon[event.split.secondIndex], className: "selected-line" },
    }));
    return;
  }

  if (event.type === "computed") {
    const detail = buildComputedGeometry(event, algorithm, curveAmplitude, segmentLength);
    frames.push(frame(algorithm === "curved_bisection" ? "Compute the curved split" : "Compute the straight split", detail.description, {
      ...common,
      points: labelVertices(event.polygon),
      selectedLine: { from: event.polygon[event.split.firstIndex], to: event.polygon[event.split.secondIndex], className: "selected-line muted" },
      normals: detail.normals,
      circle: detail.circle,
      splitPath: event.splitPath,
    }));
    return;
  }

  if (event.type === "rejected") {
    frames.push(frame(`Split rejected at depth ${event.depth}`, "The main tessellation code rejected this split because it did not produce two valid child polygons after normalization.", {
      ...common,
      splitPath: event.splitPath,
    }));
    return;
  }

  if (event.type === "children") {
    frames.push(frame("Create two child lots", `The real split path is inserted into the boundary in both directions. This produces child areas of ${event.pieces.map((piece) => Math.abs(computeSignedArea(piece)).toFixed(0)).join(" and ")}.`, {
      basePolygon: TUTORIAL_LOT_SEGMENTED.polygon,
      partition: buildPartitionLayers(event.partition || event.pieces, null),
      polygons: event.pieces.map((points, index) => ({ points, className: `tutorial-piece piece-${index}` })),
      splitPath: event.splitPath,
    }));
  }
}

function buildPoissonTrace({ polygon, segmentLength, seed, frames }) {
  const estimatedPieces = splitLotPolygonForCount(polygon, segmentLength);
  const boundarySites = polygon.map((point) => clonePoint(point));
  const rng = createSeededRandom(seed);
  const sites = samplePoissonPointsInPolygon(polygon, Math.abs(computeSignedArea(polygon)), Math.max(2, estimatedPieces.length), rng, boundarySites);
  const voronoiSites = [...boundarySites, ...sites];
  const bbox = computeBoundingBox(polygon);
  const delaunay = Delaunay.from(voronoiSites.map((point) => [point.x, point.y]));
  const voronoi = delaunay.voronoi([
    bbox.minX - POISSON_BBOX_PADDING,
    bbox.minY - POISSON_BBOX_PADDING,
    bbox.maxX + POISSON_BBOX_PADDING,
    bbox.maxY + POISSON_BBOX_PADDING,
  ]);
  const rawCells = voronoiSites.map((_, index) => sanitizeCellPolygon(voronoi.cellPolygon(index)));
  const clippedCells = rawCells.map((cell) => normalizePolygon(clipPolygonToPolygon(cell, polygon))).filter((cell) => cell.length >= 3);

  frames.push(frame("Estimate the target count", `Poisson Voronoi first runs the straight bisection logic to estimate how many sublots this lot should produce. Here that target is ${estimatedPieces.length}.`, {
    basePolygon: polygon,
    polygons: [{ points: polygon, className: "tutorial-active-area" }],
  }));
  frames.push(frame("Seed the boundary", "The existing lot boundary vertices are inserted as fixed Voronoi input sites. They shape the cells near the border before clipping happens.", {
    basePolygon: polygon,
    polygons: [{ points: polygon, className: "tutorial-active-area" }],
    points: boundarySites.map((point, index) => ({ point, label: `B${index}`, className: "boundary-site" })),
  }));
  frames.push(frame("Sample Poisson sites", `${sites.length} interior Poisson sites are sampled with a minimum-distance rule. The boundary vertices are already in the spacing set, so interior sites cannot be placed too close to the segmented lot edge.`, {
    basePolygon: polygon,
    polygons: [{ points: polygon, className: "tutorial-active-area" }],
    points: [
      ...boundarySites.map((point) => ({ point, className: "boundary-site" })),
      ...sites.map((point, index) => ({ point, label: String(index), className: "poisson-site" })),
    ],
  }));
  frames.push(frame("Build Voronoi cells", "The Voronoi diagram is computed from both boundary vertices and Poisson sites. This frame shows raw cells for every generated site, including boundary vertices.", {
    basePolygon: polygon,
    polygons: [{ points: polygon, className: "tutorial-active-area" }, ...rawCells.map((points) => ({ points, className: "raw-voronoi" }))],
    points: [
      ...boundarySites.map((point) => ({ point, className: "boundary-site" })),
      ...sites.map((point) => ({ point, className: "poisson-site" })),
    ],
  }));
  frames.push(frame("Clip to the lot", "Each raw cell is clipped back to the original lot polygon. Boundary-site cells are included, so the final sublots cover both edge and interior regions.", {
    basePolygon: polygon,
    polygons: clippedCells.map((points, index) => ({ points, className: `tutorial-piece piece-${index % 6}` })),
    points: [
      ...boundarySites.map((point) => ({ point, className: "boundary-site" })),
      ...sites.map((point) => ({ point, className: "poisson-site" })),
    ],
  }));

  return frames;
}

function buildComputedGeometry(event, algorithm, curveAmplitude, segmentLength) {
  if (algorithm === "curved_bisection") {
    const inspection = inspectCurvedBisection(event.polygon, event.split.firstIndex, event.split.secondIndex, segmentLength * 0.5, curveAmplitude);
    const normals = [
      { from: inspection.start, to: addScaled(inspection.start, inspection.startDirection, inspection.guideLength), className: "normal-line" },
      { from: inspection.end, to: addScaled(inspection.end, inspection.endDirection, inspection.guideLength), className: "normal-line" },
    ];
    const circle = inspection.arc
      ? { center: inspection.arc.center, radius: inspection.arc.radius }
      : null;
    const description = inspection.arc
      ? `Interior bisectors define endpoint tangents. Their radius lines define a tangent-guided circle through both selected vertices, creating an arc of radius ${inspection.arc.radius.toFixed(1)}.`
      : inspection.fallbackReason;
    return { path: inspection.path, normals, circle, description };
  }

  return {
    path: event.splitPath,
    normals: [],
    circle: null,
    description: "Straight bisection resamples the chosen chord into short segments, then inserts that chord into both child polygon boundaries.",
  };
}

function splitLotPolygonForCount(polygon, segmentLength) {
  return splitLotPolygonRecursively(normalizePolygon(polygon), segmentLength, "straight_bisection");
}

function samplePoissonPointsInPolygon(polygon, area, targetCount, rng, spacingObstacles = []) {
  const bbox = computeBoundingBox(polygon);
  const spacingSiteCount = targetCount + spacingObstacles.length;
  const nominalSpacing = Math.sqrt(area / Math.max(1, spacingSiteCount));
  const minDistance = Math.max(1, nominalSpacing * POISSON_SPACING_RATIO);
  const points = [];
  const spacingPoints = [];
  spacingObstacles.forEach((point) => addSpacingPoint(point));
  while (points.length < targetCount) {
    const point = chooseBestCandidatePoint();
    if (!point) {
      break;
    }
    addPoint(point);
  }
  return points.slice(0, targetCount);

  function addPoint(point) {
    points.push(point);
    addSpacingPoint(point);
  }
  function addSpacingPoint(point) {
    spacingPoints.push(point);
  }
  function chooseBestCandidatePoint() {
    let best = null;
    let bestDistance = -Infinity;
    for (let attempt = 0; attempt < POISSON_CANDIDATE_ATTEMPTS; attempt += 1) {
      const point = randomCandidatePoint();
      if (!point) {
        continue;
      }
      const distance = nearestSpacingDistance(point);
      if (distance > bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    return best && bestDistance + EPSILON >= minDistance ? best : null;
  }
  function randomCandidatePoint(maxAttempts = POISSON_MAX_ATTEMPTS) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const point = { x: rng.between(bbox.minX, bbox.maxX), y: rng.between(bbox.minY, bbox.maxY) };
      if (pointInPolygon(point, polygon)) {
        return point;
      }
    }
    return null;
  }
  function nearestSpacingDistance(point) {
    return spacingPoints.reduce((minimum, neighbor) => Math.min(minimum, pointDistance(point, neighbor)), Infinity);
  }
}

function frame(title, body, geometry) {
  return { title, body, geometry };
}

function buildPartitionLayers(partition, activePolygon) {
  return partition
    .filter((piece) => piece.length >= 3)
    .map((piece) => ({
      points: piece,
      className: activePolygon && samePolygon(piece, activePolygon) ? "tutorial-partition-active" : "tutorial-partition-muted",
    }));
}

function samePolygon(first, second) {
  if (!first || !second || first.length !== second.length) {
    return false;
  }
  return first.every((point, index) => pointDistance(point, second[index]) <= EPSILON);
}

function splitPolygonEdgesIntoSegments(polygon, targetLength) {
  const segmented = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    const length = pointDistance(from, to);
    const count = Math.max(1, Math.ceil(length / targetLength));
    for (let segmentIndex = 0; segmentIndex < count; segmentIndex += 1) {
      const t = segmentIndex / count;
      segmented.push({
        x: from.x + ((to.x - from.x) * t),
        y: from.y + ((to.y - from.y) * t),
      });
    }
  }
  return normalizePolygon(segmented);
}

function labelVertices(polygon, blockedVertexKeys = new Set()) {
  return polygon.map((point, index) => ({
    point,
    label: String(index),
    className: blockedVertexKeys.has(pointKey(point)) ? "blocked-vertex" : "vertex",
  }));
}

function addScaled(origin, vector, scalar) {
  return { x: origin.x + (vector.x * scalar), y: origin.y + (vector.y * scalar) };
}

function sanitizeCellPolygon(polygon) {
  return polygon ? normalizePolygon(polygon.slice(0, -1).map(([x, y]) => ({ x, y }))) : [];
}

function clipPolygonToPolygon(subject, clipPolygon) {
  let output = subject.map((point) => clonePoint(point));
  for (let index = 0; index < clipPolygon.length; index += 1) {
    const clipStart = clipPolygon[index];
    const clipEnd = clipPolygon[(index + 1) % clipPolygon.length];
    const input = output;
    output = [];
    if (!input.length) {
      break;
    }
    let previous = input[input.length - 1];
    for (const current of input) {
      const currentInside = cross2d(clipStart, clipEnd, current) >= -EPSILON;
      const previousInside = cross2d(clipStart, clipEnd, previous) >= -EPSILON;
      if (currentInside) {
        if (!previousInside) {
          output.push(lineIntersection(previous, current, clipStart, clipEnd));
        }
        output.push(clonePoint(current));
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }
      previous = current;
    }
  }
  return normalizePolygon(output);
}

function lineIntersection(firstFrom, firstTo, secondFrom, secondTo) {
  const firstDx = firstTo.x - firstFrom.x;
  const firstDy = firstTo.y - firstFrom.y;
  const secondDx = secondTo.x - secondFrom.x;
  const secondDy = secondTo.y - secondFrom.y;
  const denominator = (firstDx * secondDy) - (firstDy * secondDx);
  if (Math.abs(denominator) <= EPSILON) {
    return clonePoint(firstTo);
  }
  const deltaX = secondFrom.x - firstFrom.x;
  const deltaY = secondFrom.y - firstFrom.y;
  const t = ((deltaX * secondDy) - (deltaY * secondDx)) / denominator;
  return { x: firstFrom.x + (firstDx * t), y: firstFrom.y + (firstDy * t) };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (((current.y > point.y) !== (previous.y > point.y)) && point.x < (((previous.x - current.x) * (point.y - current.y)) / ((previous.y - current.y) || EPSILON)) + current.x) {
      inside = !inside;
    }
  }
  return inside;
}

function normalizePolygon(points) {
  const normalized = [];
  points.forEach((point) => {
    const previous = normalized[normalized.length - 1];
    if (!previous || pointDistance(previous, point) > EPSILON) {
      normalized.push(clonePoint(point));
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
  const areaTwice = computeSignedArea(polygon) * 2;
  if (Math.abs(areaTwice) < EPSILON) {
    return {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
  }
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const factor = current.x * next.y - next.x * current.y;
    centroidX += (current.x + next.x) * factor;
    centroidY += (current.y + next.y) * factor;
  }
  return { x: centroidX / (3 * areaTwice), y: centroidY / (3 * areaTwice) };
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

function computeBoundingBox(polygon) {
  return polygon.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function cross2d(from, to, point) {
  return ((to.x - from.x) * (point.y - from.y)) - ((to.y - from.y) * (point.x - from.x));
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}
