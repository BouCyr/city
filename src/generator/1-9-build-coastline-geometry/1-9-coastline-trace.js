/*
 * WHAT: Build tutorial frames for the coastline smoothing step.
 * HOW: Feed fixed land/sea edge datasets through the same coastline trace builder used by production.
 * WHY: The tutorial should explain the actual step 1.9 behavior without a separate drawing-only algorithm.
 */

import { convertCellGeometryToCoastlineLotGeometry } from "../map-model.js";
import { buildCoastlineTrace } from "../coastline-model.js";

const TUTORIAL_SEGMENT_LENGTH = 70;

export const COASTLINE_TUTORIAL_DATASETS = {
  threeCellIsland: buildThreeCellIslandDataset(),
  northSouthCoastline: buildNorthSouthCoastlineDataset(),
  snakingRiverLand: buildSnakingRiverLandDataset(),
};

export const DEFAULT_COASTLINE_DATASET = COASTLINE_TUTORIAL_DATASETS.threeCellIsland;

export function buildCoastlineTutorialTrace(dataset = DEFAULT_COASTLINE_DATASET) {
  const trace = buildCoastlineTrace(dataset.map, {
    segmentLength: TUTORIAL_SEGMENT_LENGTH,
  });
  const finalMap = convertCellGeometryToCoastlineLotGeometry(dataset.map, TUTORIAL_SEGMENT_LENGTH);
  const finalPaths = Array.from(trace.edgePathById.entries()).map(([edgeId, points]) => ({
    edgeId,
    points,
    className: "coastline-final-path",
  }));
  const riverFrames = dataset.riverPaths?.length ? buildRiverFrames(dataset) : [];

  return {
    dataset,
    trace,
    frames: [
      frame("Raw unsegmented edges", "The fixed dataset starts as straight Voronoi-like boundaries with land and sea cells on either side.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({ ...edge, className: "coastline-raw-edge" })),
      }),
      frame("Classify coast edges", "Edges with land on one side and sea on the other are marked as coastline. Pure land or pure sea edges are left for later steps.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({
          ...edge,
          className: trace.edgePathById.has(edge.id) ? "coastline-coast-edge" : "coastline-muted-edge",
        })),
      }),
      frame("Trace coast chains", `The coast edges become ${trace.chains.length} ordered chain${trace.chains.length === 1 ? "" : "s"}. Closed chains loop back to the first vertex; open chains synthesize endpoint tangents.`, {
        cells: dataset.cells,
        edges: chainEdges(trace, dataset.edges),
      }),
      frame("Find midpoint controls", "Each original coast edge contributes its midpoint, and each shared coastline vertex becomes the quadratic Bezier control point.", {
        cells: dataset.cells,
        edges: chainEdges(trace, dataset.edges),
        points: [
          ...trace.coastEdges.map((edge) => ({ point: edge.midpoint, label: "M", className: "coastline-midpoint" })),
          ...uniqueControlPoints(trace.curves).map((point) => ({ point, label: "C", className: "coastline-control-point" })),
        ],
      }),
      frame("Build Bezier curves", "At every coastline vertex, the curve runs from the previous edge midpoint to the next edge midpoint, using that vertex as the control point.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({ ...edge, className: "coastline-muted-edge" })),
        curves: trace.curves.map((curve) => ({ points: curve.points, className: "coastline-bezier-guide" })),
        points: uniqueControlPoints(trace.curves).map((point) => ({ point, label: "C", className: "coastline-control-point" })),
      }),
      frame("Sample short segments", `The Bezier curves are sampled into points using the same scale as the bisection tutorial (${TUTORIAL_SEGMENT_LENGTH}px). These sampled points are the only geometry emitted downstream.`, {
        cells: dataset.cells,
        curves: trace.curves.map((curve) => ({ points: curve.points, className: "coastline-bezier-guide" })),
        points: trace.curves.flatMap((curve) => curve.points.map((point) => ({ point, className: "coastline-sample-point" }))),
      }),
      frame("Final canonical coastline", "The final output is ordinary segment geometry. The original coastline edges have been replaced by sampled polylines, ready for lot rebuilding.", {
        cells: dataset.cells,
        curves: finalPaths,
        points: Array.from(trace.replacementPointByVertexKey.values()).map((point) => ({ point, className: "coastline-reconnect-point" })),
      }),
      frame("Rebuilt lot geometry", "This is the actual modified step output: lots are rebuilt against the sampled coastline, and the final coastline is ordinary shared segment geometry.", {
        lots: finalMap.lots,
        segments: finalMap.segments,
      }),
      ...riverFrames,
    ],
  };
}

function frame(title, body, geometry) {
  return { title, body, geometry };
}

function chainEdges(trace, edges) {
  const chainIndexByEdgeId = new Map();
  trace.chains.forEach((chain, index) => {
    chain.edgeIds.forEach((edgeId) => {
      chainIndexByEdgeId.set(edgeId, index);
    });
  });
  return edges.map((edge) => {
    const chainIndex = chainIndexByEdgeId.get(edge.id);
    return {
      ...edge,
      className: chainIndex === undefined ? "coastline-muted-edge" : `coastline-chain-edge chain-${chainIndex % 4}`,
    };
  });
}

function uniqueControlPoints(curves) {
  const points = [];
  const keys = new Set();
  curves.forEach((curve) => {
    const key = `${curve.control.x.toFixed(4)},${curve.control.y.toFixed(4)}`;
    if (!keys.has(key)) {
      keys.add(key);
      points.push(curve.control);
    }
  });
  return points;
}

function buildRiverFrames(dataset) {
  const riverTraces = dataset.riverPaths.map((path) => buildRiverBezierTrace(path));
  return [
    frame("Build river Bezier curves", "The river sample uses the same midpoint-control-point smoothing pattern: each bend controls a short Bezier arc between adjacent span midpoints.", {
      cells: dataset.cells,
      riverCurves: riverTraces.flatMap((trace) => trace.curves.map((curve) => ({ points: curve.points, className: "coastline-river-bezier-guide" }))),
      points: riverTraces.flatMap((trace) => trace.controls.map((point) => ({ point, label: "R", className: "coastline-control-point" }))),
    }),
    frame("Final smoothed river segments", "The angular river path is emitted as ordinary short river segments after smoothing. Merge points would be pinned exactly in the production step so tributaries share the same vertex as the primary river.", {
      cells: dataset.cells,
      riverCurves: riverTraces.map((trace) => ({ points: trace.path, className: "coastline-final-river-path" })),
      points: riverTraces.flatMap((trace) => trace.path.map((point) => ({ point, className: "coastline-sample-point" }))),
    }),
  ];
}

function buildRiverBezierTrace(points) {
  const curves = [];
  const path = [];
  for (let index = 0; index < points.length; index += 1) {
    const control = points[index];
    const previousMidpoint = index > 0 ? midpoint(points[index - 1], control) : null;
    const nextMidpoint = index < points.length - 1 ? midpoint(control, points[index + 1]) : null;
    const start = previousMidpoint || mirrorPoint(nextMidpoint, control);
    const end = nextMidpoint || mirrorPoint(previousMidpoint, control);
    const curvePoints = sampleQuadraticBezier(start, control, end, TUTORIAL_SEGMENT_LENGTH);
    curves.push({ points: curvePoints, control });
    appendTracePath(path, curvePoints);
  }
  return {
    curves,
    controls: points,
    path,
  };
}

function sampleQuadraticBezier(start, control, end, targetLength) {
  const approximateLength = distance(start, control) + distance(control, end);
  const segmentCount = Math.max(2, Math.ceil(approximateLength / targetLength));
  const points = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const t = index / segmentCount;
    const inverse = 1 - t;
    points.push({
      x: (inverse * inverse * start.x) + (2 * inverse * t * control.x) + (t * t * end.x),
      y: (inverse * inverse * start.y) + (2 * inverse * t * control.y) + (t * t * end.y),
    });
  }
  return points;
}

function appendTracePath(target, path) {
  path.forEach((point) => {
    const previous = target[target.length - 1];
    if (!previous || distance(previous, point) > 0.0001) {
      target.push(point);
    }
  });
}

function midpoint(first, second) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function mirrorPoint(point, origin) {
  return {
    x: (origin.x * 2) - point.x,
    y: (origin.y * 2) - point.y,
  };
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function buildThreeCellIslandDataset() {
  const a = point(300, 95);
  const b = point(500, 190);
  const c = point(560, 380);
  const d = point(390, 540);
  const e = point(160, 500);
  const f = point(80, 280);
  const center = point(315, 320);
  const cells = [
    landCell(0, [a, b, c, center]),
    landCell(1, [center, c, d, e]),
    landCell(2, [a, center, e, f]),
    seaCell(10, [a, b, point(560, 110), point(350, 20)]),
    seaCell(11, [b, c, point(650, 410), point(590, 160)]),
    seaCell(12, [c, d, point(430, 650), point(650, 460)]),
    seaCell(13, [d, e, point(90, 610), point(430, 650)]),
    seaCell(14, [e, f, point(0, 300), point(90, 610)]),
    seaCell(15, [f, a, point(350, 20), point(0, 300)]),
  ];
  const edges = [
    coastEdge("island:a-b", a, b, 0, 10),
    coastEdge("island:b-c", b, c, 0, 11),
    coastEdge("island:c-d", c, d, 1, 12),
    coastEdge("island:d-e", d, e, 1, 13),
    coastEdge("island:e-f", e, f, 2, 14),
    coastEdge("island:f-a", f, a, 2, 15),
    landEdge("island:center-c", center, c, 0, 1),
    landEdge("island:center-e", center, e, 1, 2),
    landEdge("island:center-a", center, a, 2, 0),
  ];
  return { id: "threeCellIsland", name: "Three-cell island", cells, edges, map: tutorialMap(cells, edges, 700) };
}

function buildNorthSouthCoastlineDataset() {
  const v0 = point(300, 80);
  const v1 = point(330, 190);
  const v2 = point(280, 300);
  const v3 = point(320, 410);
  const v4 = point(290, 530);
  const cells = [
    landCell(0, [point(80, 70), v0, v1, point(90, 200)]),
    landCell(1, [point(90, 200), v1, v2, point(70, 310)]),
    landCell(2, [point(70, 310), v2, v3, point(100, 430)]),
    landCell(3, [point(100, 430), v3, v4, point(80, 560)]),
    seaCell(10, [v0, point(560, 70), point(570, 205), v1]),
    seaCell(11, [v1, point(570, 205), point(550, 320), v2]),
    seaCell(12, [v2, point(550, 320), point(580, 420), v3]),
    seaCell(13, [v3, point(580, 420), point(560, 560), v4]),
  ];
  const edges = [
    coastEdge("coast:0", v0, v1, 0, 10),
    coastEdge("coast:1", v1, v2, 1, 11),
    coastEdge("coast:2", v2, v3, 2, 12),
    coastEdge("coast:3", v3, v4, 3, 13),
    landEdge("land:0-1", point(90, 200), v1, 0, 1),
    landEdge("land:1-2", point(70, 310), v2, 1, 2),
    landEdge("land:2-3", point(100, 430), v3, 2, 3),
  ];
  return { id: "northSouthCoastline", name: "North-south coastline", cells, edges, map: tutorialMap(cells, edges, 650) };
}

function buildSnakingRiverLandDataset() {
  const size = 700;
  const columns = 4;
  const rows = 6;
  const cellWidth = size / columns;
  const cellHeight = size / rows;
  const cells = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const id = (row * columns) + column;
      const x = column * cellWidth;
      const y = row * cellHeight;
      cells.push(landCell(id, [
        point(x, y),
        point(x + cellWidth, y),
        point(x + cellWidth, y + cellHeight),
        point(x, y + cellHeight),
      ]));
    }
  }

  const edges = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const x = column * cellWidth;
      const from = point(x, row * cellHeight);
      const to = point(x, (row + 1) * cellHeight);
      const leftCellId = column > 0 ? (row * columns) + column - 1 : null;
      const rightCellId = column < columns ? (row * columns) + column : null;
      edges.push(landEdge(`riverland:v:${row}:${column}`, from, to, leftCellId, rightCellId));
    }
  }
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const y = row * cellHeight;
      const from = point(column * cellWidth, y);
      const to = point((column + 1) * cellWidth, y);
      const topCellId = row > 0 ? ((row - 1) * columns) + column : null;
      const bottomCellId = row < rows ? (row * columns) + column : null;
      edges.push(landEdge(`riverland:h:${row}:${column}`, from, to, bottomCellId, topCellId));
    }
  }

  const riverPaths = [[
    point(360, 0),
    point(295, 70),
    point(425, 145),
    point(235, 235),
    point(465, 330),
    point(255, 430),
    point(410, 535),
    point(335, 620),
    point(355, 700),
  ]];

  return {
    id: "snakingRiverLand",
    name: "Snaking river land",
    cells,
    edges,
    riverPaths,
    map: {
      ...tutorialMap(cells, edges, size),
      rivers: [{ id: 0, points: riverPaths[0] }],
    },
  };
}

function tutorialMap(cells, edges, size) {
  return {
    meta: { size },
    cells,
    edges,
  };
}

function landCell(id, polygon) {
  return tutorialCell(id, polygon, { land: true, sea: false });
}

function seaCell(id, polygon) {
  return tutorialCell(id, polygon, { land: false, sea: true });
}

function tutorialCell(id, polygon, features) {
  return {
    id,
    site: centroid(polygon),
    polygon,
    centroid: centroid(polygon),
    boundarySides: [],
    features: {
      ...features,
      river: false,
      boundary: false,
      cityCenter: false,
    },
  };
}

function coastEdge(id, from, to, leftCellId, rightCellId) {
  return edge(id, from, to, leftCellId, rightCellId);
}

function landEdge(id, from, to, leftCellId, rightCellId) {
  return edge(id, from, to, leftCellId, rightCellId);
}

function edge(id, from, to, leftCellId, rightCellId) {
  return {
    id,
    from,
    to,
    midpoint: point((from.x + to.x) / 2, (from.y + to.y) / 2),
    leftCellId,
    rightCellId,
    features: {
      boundary: false,
      sea: false,
      river: false,
    },
  };
}

function point(x, y) {
  return { x, y };
}

function centroid(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}
