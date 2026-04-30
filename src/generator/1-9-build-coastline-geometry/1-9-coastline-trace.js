/*
 * WHAT: Build tutorial frames for the coastline smoothing step.
 * HOW: Feed fixed land/sea edge datasets through the same coastline trace builder used by production.
 * WHY: The tutorial should explain the actual step 1.9 behavior without a separate drawing-only algorithm.
 */

import { DEFAULT_SEGMENT_LENGTH } from "../map-model.js";
import { buildCoastlineTrace } from "../coastline-model.js";

export const COASTLINE_TUTORIAL_DATASETS = {
  threeCellIsland: buildThreeCellIslandDataset(),
  northSouthCoastline: buildNorthSouthCoastlineDataset(),
};

export const DEFAULT_COASTLINE_DATASET = COASTLINE_TUTORIAL_DATASETS.threeCellIsland;

export function buildCoastlineTutorialTrace(dataset = DEFAULT_COASTLINE_DATASET) {
  const trace = buildCoastlineTrace(dataset.map, {
    segmentLength: DEFAULT_SEGMENT_LENGTH * 0.5,
  });
  const finalPaths = Array.from(trace.edgePathById.entries()).map(([edgeId, points]) => ({
    edgeId,
    points,
    className: "coastline-final-path",
  }));

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
      frame("Sample short segments", "The Bezier curves are sampled into short points at half the default segment length. These sampled points are the only geometry emitted downstream.", {
        cells: dataset.cells,
        curves: trace.curves.map((curve) => ({ points: curve.points, className: "coastline-bezier-guide" })),
        points: trace.curves.flatMap((curve) => curve.points.map((point) => ({ point, className: "coastline-sample-point" }))),
      }),
      frame("Final canonical coastline", "The final output is ordinary segment geometry. The original coastline edges have been replaced by sampled polylines, ready for lot rebuilding.", {
        cells: dataset.cells,
        curves: finalPaths,
        points: Array.from(trace.replacementPointByVertexKey.values()).map((point) => ({ point, className: "coastline-reconnect-point" })),
      }),
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
