/*
 * WHAT: Define the canonical map object shared by generation, replay, and rendering.
 * HOW: Create initial maps, normalize Voronoi geometry into canonical cells/edges, and snapshot states for frames.
 * WHY: A single stable shape keeps step modules small and prevents renderer-facing ad hoc fields from spreading.
 */

import { cross } from "./geometry.js";

export const BLANK_STEP_INDEX = -1;

const SNAPSHOT_FALLBACK = (value) => JSON.parse(JSON.stringify(value));

export function createInitialMap(options) {
  return {
    init: {
      seed: options.seed,
      params: {
        seed: options.seed,
        pointCount: options.pointCount,
        riverCount: options.riverCount,
        waterSides: options.waterSides.map((side) => ({ ...side })),
        mapSize: options.mapSize,
      },
    },
    meta: {
      size: options.mapSize,
      stepIndex: BLANK_STEP_INDEX,
      stepLabel: "Blank map",
    },
    points: [],
    cells: [],
    edges: [],
    rivers: [],
    water: {
      sides: [],
      seaCellIds: [],
    },
    cityCenterCellId: null,
  };
}

export function withStepMetadata(map, stepIndex, stepLabel) {
  return {
    ...map,
    meta: {
      ...map.meta,
      stepIndex,
      stepLabel,
    },
  };
}

export function createFrame(label, map, stepIndex, stepLabel = label) {
  return map
    ? {
        type: "map",
        label,
        stepIndex,
        map: snapshotMap(withStepMetadata(map, stepIndex, stepLabel)),
      }
    : {
        type: "blank",
        label,
        stepIndex,
      };
}

export function snapshotMap(map) {
  return typeof structuredClone === "function" ? structuredClone(map) : SNAPSHOT_FALLBACK(map);
}

export function buildCanonicalGeometry(diagram) {
  const cells = diagram.cells.map((cell) => {
    const boundarySides = Object.entries(cell.touches)
      .filter(([, touched]) => touched)
      .map(([side]) => side);

    return {
      id: cell.id,
      site: {
        x: cell.site.x,
        y: cell.site.y,
      },
      centroid: {
        x: cell.centroid.x,
        y: cell.centroid.y,
      },
      polygon: cell.polygon.map((point) => ({ x: point.x, y: point.y })),
      edgeIds: [],
      neighborCellIds: [...cell.neighbors],
      boundarySides,
      features: {
        land: true,
        sea: false,
        river: false,
        boundary: boundarySides.length > 0,
        cityCenter: false,
      },
    };
  });

  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const edges = diagram.edges.map((edge) => {
    const oriented = orientEdge(edge, cellById);
    if (oriented.leftCellId !== null) {
      cellById.get(oriented.leftCellId)?.edgeIds.push(oriented.id);
    }
    if (oriented.rightCellId !== null && oriented.rightCellId !== oriented.leftCellId) {
      cellById.get(oriented.rightCellId)?.edgeIds.push(oriented.id);
    }
    return oriented;
  });

  return { cells, edges };
}

export function buildSummary(map) {
  return {
    pointCount: map.points.length,
    cellCount: map.cells.length,
    edgeCount: map.edges.length,
    seaCellCount: map.cells.filter((cell) => cell.features.sea).length,
    riverCount: map.rivers.length,
  };
}

function orientEdge(edge, cellById) {
  const midpoint = {
    x: (edge.from.x + edge.to.x) / 2,
    y: (edge.from.y + edge.to.y) / 2,
  };
  const adjacentCellIds = [edge.a, edge.b].filter((cellId) => cellId !== null);

  if (adjacentCellIds.length === 1) {
    const cellId = adjacentCellIds[0];
    const side = pointSide(edge.from, edge.to, cellById.get(cellId)?.centroid);
    return {
      id: edge.id,
      from: { x: edge.from.x, y: edge.from.y },
      to: { x: edge.to.x, y: edge.to.y },
      midpoint,
      leftCellId: side >= 0 ? cellId : null,
      rightCellId: side < 0 ? cellId : null,
      features: {
        boundary: true,
        sea: false,
        river: false,
      },
    };
  }

  const [firstId, secondId] = adjacentCellIds;
  const firstSide = pointSide(edge.from, edge.to, cellById.get(firstId)?.centroid);
  const secondSide = pointSide(edge.from, edge.to, cellById.get(secondId)?.centroid);

  return {
    id: edge.id,
    from: { x: edge.from.x, y: edge.from.y },
    to: { x: edge.to.x, y: edge.to.y },
    midpoint,
    leftCellId: firstSide >= secondSide ? firstId : secondId,
    rightCellId: firstSide >= secondSide ? secondId : firstId,
    features: {
      boundary: false,
      sea: false,
      river: false,
    },
  };
}

function pointSide(from, to, point) {
  if (!point) {
    return 0;
  }

  return cross(
    {
      x: to.x - from.x,
      y: to.y - from.y,
    },
    {
      x: point.x - from.x,
      y: point.y - from.y,
    },
  );
}
