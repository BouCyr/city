/*
 * WHAT: Build human-readable tutorial frames for the lot tessellation algorithms.
 * HOW: Reuse the same split path builders as lot tessellation while recording the intermediate geometry.
 * WHY: The illustration page should explain the real algorithm without duplicating renderer-only logic.
 */

import { DEFAULT_SEGMENT_LENGTH, clonePoint, pointDistance } from "../map-model.js";
import { inspectCurvedBisection } from "./2-6-curved-bisection.js";
import { splitLotPolygonRecursively } from "./2-6-field-dispatch.js";

const EPSILON = 0.0001;
export const TUTORIAL_LOTS = {
  potato: {
    id: 436,
    name: "Potato",
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
  },
  concave: {
    id: 437,
    name: "Concave",
    polygon: [
      { x: 110, y: 190 },
      { x: 330, y: 120 },
      { x: 610, y: 150 },
      { x: 760, y: 315 },
      { x: 610, y: 500 },
      { x: 445, y: 395 },
      { x: 280, y: 615 },
      { x: 95, y: 470 },
    ],
  },
  elongated: {
    id: 438,
    name: "Elongated",
    polygon: [
      { x: 70, y: 330 },
      { x: 170, y: 235 },
      { x: 390, y: 185 },
      { x: 660, y: 215 },
      { x: 800, y: 330 },
      { x: 710, y: 445 },
      { x: 445, y: 505 },
      { x: 185, y: 470 },
    ],
  },
  parallelTangents: {
    id: 439,
    name: "Parallel tangents",
    polygon: [
      { x: 120, y: 170 },
      { x: 700, y: 170 },
      { x: 790, y: 260 },
      { x: 700, y: 350 },
      { x: 120, y: 350 },
      { x: 30, y: 260 },
    ],
  },
};

export const TUTORIAL_LOT = TUTORIAL_LOTS.potato;

const FALLBACK_SEGMENTED_LOT = {
  id: 436,
  polygon: normalizePolygon(TUTORIAL_LOT.polygon),
};

export function buildBisectionTutorialTrace({
  algorithm = "straight_bisection",
  lot = TUTORIAL_LOT,
  segmentLength = DEFAULT_SEGMENT_LENGTH,
  curveAmplitude = 0.35,
} = {}) {
  const originalPolygon = normalizePolygon(lot.polygon);
  const polygon = normalizePolygon(lot.polygon);
  const segmentedLot = { id: lot.id, polygon };
  const frames = [
    frame("Original fixed lot", `The tutorial starts from the ${lot.name || "selected"} lot. It is drawn as one polygon before the bisection code prepares its working vertices.`, {
      basePolygon: originalPolygon,
      polygons: [{ points: originalPolygon, className: "tutorial-active-area" }],
      points: labelVertices(originalPolygon),
    }),
    frame("Working boundary vertices", `Step 2.5 already provides the canonical lot boundary used by field dispatch. This lot enters the bisection step with ${polygon.length} boundary vertices.`, {
      basePolygon: originalPolygon,
      polygons: [{ points: polygon, className: "tutorial-active-area segmented-lot" }],
      points: labelVertices(polygon),
    }),
  ];

  const leaves = splitLotPolygonRecursively(polygon, segmentLength, algorithm, curveAmplitude, [], (event) => {
    appendBisectionEventFrame(frames, event, algorithm, curveAmplitude, segmentLength, segmentedLot);
  });

  frames.push(frame("Finished bisection tree", `The recursion stops with ${leaves.length} leaf sublots. Each remaining polygon is too small to split safely or has no valid balanced split left.`, {
    basePolygon: polygon,
    polygons: leaves.map((points, index) => ({ points, className: `tutorial-piece piece-${index % 6}` })),
  }));

  return { lot, algorithm, frames };
}

function appendBisectionEventFrame(frames, event, algorithm, curveAmplitude, segmentLength, segmentedLot = FALLBACK_SEGMENTED_LOT) {
  const common = {
    basePolygon: segmentedLot.polygon,
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
      basePolygon: segmentedLot.polygon,
      partition: buildPartitionLayers(event.partition || event.pieces, null),
      polygons: event.pieces.map((points, index) => ({ points, className: `tutorial-piece piece-${index}` })),
      splitPath: event.splitPath,
    }));
  }
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

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}
