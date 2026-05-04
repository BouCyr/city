/*
 * WHAT: Build tutorial frames for river smoothing.
 * HOW: Generate a seeded irregular cell grid and smooth an angular river with midpoint-controlled quadratic curves.
 * WHY: The dedicated river tutorial should show river-specific geometry without coastline concepts.
 */

import { createSeededRandom } from "./random.js";

const TUTORIAL_SEGMENT_LENGTH = 58;

export const DEFAULT_RIVER_TUTORIAL_DATASET = buildIrregularRiverDataset();

export function buildRiverTutorialTrace(dataset = DEFAULT_RIVER_TUTORIAL_DATASET) {
  const riverTrace = buildRiverBezierTrace(dataset.riverPath);
  const segments = pointsToSegments(riverTrace.path);

  return {
    dataset,
    frames: [
      frame("Irregular source cells", "The river tutorial starts from a deterministic jittered cell grid so the path is not tied to a perfect rectangular lattice.", {
        cells: dataset.cells,
        edges: dataset.edges,
      }),
      frame("Angular cell path", "The selected river follows cell-to-cell turns before smoothing. Its control points are intentionally uneven to mimic a generated drainage route.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({ ...edge, className: "river-muted-edge" })),
        rawPaths: [{ points: dataset.riverPath, className: "river-raw-path" }],
        points: dataset.riverPath.map((point, index) => ({ point, label: index + 1, className: "river-control-point" })),
      }),
      frame("Find midpoint controls", "Each bend becomes a control point, and neighboring river vertices provide the half-span start and end points for that curve.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({ ...edge, className: "river-muted-edge" })),
        rawPaths: [{ points: dataset.riverPath, className: "river-muted-path" }],
        points: [
          ...riverTrace.midpoints.map((point) => ({ point, label: "M", className: "river-midpoint" })),
          ...dataset.riverPath.map((point) => ({ point, label: "R", className: "river-control-point" })),
        ],
      }),
      frame("Build Bezier curves", "Every river bend emits a short quadratic curve from one span midpoint to the next, controlled by the original angular river vertex.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({ ...edge, className: "river-muted-edge" })),
        curves: riverTrace.curves.map((curve) => ({ points: curve.points, className: "river-bezier-guide" })),
        points: dataset.riverPath.map((point) => ({ point, label: "R", className: "river-control-point" })),
      }),
      frame("Final smoothed river segments", "The smoothed path is emitted as ordinary segment geometry. Production merge points are pinned exactly before these sampled segments are added to the lot model.", {
        cells: dataset.cells,
        edges: dataset.edges.map((edge) => ({ ...edge, className: "river-muted-edge" })),
        segments,
        points: riverTrace.path.map((point) => ({ point, className: "river-sample-point" })),
      }),
    ],
  };
}

function buildIrregularRiverDataset() {
  const rng = createSeededRandom("river-smoothing-tutorial");
  const size = 720;
  const columns = 5;
  const rows = 7;
  const lattice = [];

  for (let row = 0; row <= rows; row += 1) {
    const line = [];
    for (let column = 0; column <= columns; column += 1) {
      const baseX = (column / columns) * size;
      const baseY = (row / rows) * size;
      const isBoundary = row === 0 || row === rows || column === 0 || column === columns;
      line.push(point(
        isBoundary ? baseX : baseX + rng.between(-42, 42),
        isBoundary ? baseY : baseY + rng.between(-36, 36),
      ));
    }
    lattice.push(line);
  }

  const cells = [];
  const edges = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const id = (row * columns) + column;
      const polygon = [
        lattice[row][column],
        lattice[row][column + 1],
        lattice[row + 1][column + 1],
        lattice[row + 1][column],
      ];
      cells.push({
        id,
        polygon,
        centroid: centroid(polygon),
        features: { land: true, sea: false, river: false },
      });
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      edges.push(edge(`river:v:${row}:${column}`, lattice[row][column], lattice[row + 1][column]));
    }
  }
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      edges.push(edge(`river:h:${row}:${column}`, lattice[row][column], lattice[row][column + 1]));
    }
  }

  const riverColumns = [2.7, 1.9, 3.2, 1.4, 2.35, 3.55, 2.15, 2.55, 1.8];
  const riverPath = riverColumns.map((columnOffset, index) => {
    const y = (index / (riverColumns.length - 1)) * size;
    const x = (columnOffset / columns) * size;
    return point(
      clamp(x + rng.between(-34, 34), 22, size - 22),
      clamp(y + (index === 0 || index === riverColumns.length - 1 ? 0 : rng.between(-28, 28)), 0, size),
    );
  });

  return {
    id: "irregularRiverCells",
    name: "Irregular river cells",
    size,
    cells,
    edges,
    riverPath,
  };
}

function frame(title, body, geometry) {
  return { title, body, geometry };
}

function buildRiverBezierTrace(points) {
  const curves = [];
  const path = [];
  const midpoints = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    midpoints.push(midpoint(points[index], points[index + 1]));
  }

  for (let index = 0; index < points.length; index += 1) {
    const control = points[index];
    const previousMidpoint = index > 0 ? midpoints[index - 1] : null;
    const nextMidpoint = index < points.length - 1 ? midpoints[index] : null;
    const start = previousMidpoint || mirrorPoint(nextMidpoint, control);
    const end = nextMidpoint || mirrorPoint(previousMidpoint, control);
    const curvePoints = sampleQuadraticBezier(start, control, end, TUTORIAL_SEGMENT_LENGTH);
    curves.push({ points: curvePoints, control });
    appendTracePath(path, curvePoints);
  }

  return {
    curves,
    midpoints,
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

function pointsToSegments(points) {
  return points.slice(1).map((point, index) => ({
    id: `river-segment:${index}`,
    from: points[index],
    to: point,
    className: "river-final-segment",
  }));
}

function appendTracePath(target, path) {
  path.forEach((point) => {
    const previous = target[target.length - 1];
    if (!previous || distance(previous, point) > 0.0001) {
      target.push(point);
    }
  });
}

function edge(id, from, to) {
  return { id, from, to, className: "river-grid-edge" };
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

function centroid(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function point(x, y) {
  return { x, y };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}
