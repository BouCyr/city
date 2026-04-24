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
        scatterPaddingRatio: options.scatterPaddingRatio,
        waterReachRatio: options.waterReachRatio,
        waterExpansionBase: options.waterExpansionBase,
        waterExpansionEdgeWeight: options.waterExpansionEdgeWeight,
        waterPressureRangeRatio: options.waterPressureRangeRatio,
        waterCenterBiasRadiusRatio: options.waterCenterBiasRadiusRatio,
        relaxPaddingRatio: options.relaxPaddingRatio,
        hillCount: options.hillCount,
        hillSeaDistance: options.hillSeaDistance,
        hillsideRadius: options.hillsideRadius,
        riverTurnAngle: options.riverTurnAngle,
        tributarySourceRiverDistance: options.tributarySourceRiverDistance,
        tributaryMergeSeaDistance: options.tributaryMergeSeaDistance,
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
      neighborCellIds: [],
      boundarySides,
      features: {
        land: true,
        sea: false,
        hill: false,
        hillside: false,
        river: false,
        boundary: boundarySides.length > 0,
        cityCenter: false,
      },
    };
  });

  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const edges = diagram.edges.map((edge) => {
    const oriented = orientEdge(edge, cellById, diagram.width, diagram.height);
    if (oriented.leftCellId !== null) {
      cellById.get(oriented.leftCellId)?.edgeIds.push(oriented.id);
    }
    if (oriented.rightCellId !== null && oriented.rightCellId !== oriented.leftCellId) {
      cellById.get(oriented.rightCellId)?.edgeIds.push(oriented.id);
    }
    return oriented;
  });

  edges.forEach((edge) => {
    if (edge.leftCellId === null || edge.rightCellId === null || edge.leftCellId === edge.rightCellId) {
      return;
    }

    const leftCell = cellById.get(edge.leftCellId);
    const rightCell = cellById.get(edge.rightCellId);
    if (leftCell && !leftCell.neighborCellIds.includes(edge.rightCellId)) {
      leftCell.neighborCellIds.push(edge.rightCellId);
    }
    if (rightCell && !rightCell.neighborCellIds.includes(edge.leftCellId)) {
      rightCell.neighborCellIds.push(edge.leftCellId);
    }
  });

  return { cells, edges };
}

export function buildSummary(map) {
  return {
    pointCount: map.points.length,
    cellCount: map.cells.length,
    edgeCount: map.edges.length,
    seaCellCount: map.cells.filter((cell) => cell.features.sea).length,
    hillCount: map.cells.filter((cell) => cell.features.hill).length,
    hillsideCount: map.cells.filter((cell) => cell.features.hillside).length,
    riverCount: map.rivers.length,
  };
}

function orientEdge(edge, cellById, width, height) {
  const midpoint = {
    x: (edge.from.x + edge.to.x) / 2,
    y: (edge.from.y + edge.to.y) / 2,
  };
  const adjacentCellIds = [edge.a, edge.b].filter((cellId) => cellId !== null);
  const isBoundary = edge.isBoundary === true || liesOnCanvasBoundary(edge, width, height);

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
        boundary: isBoundary,
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
        boundary: isBoundary,
        sea: false,
        river: false,
      },
  };
}

function liesOnCanvasBoundary(edge, width, height, epsilon = 0.75) {
  return (
    (Math.abs(edge.from.x) <= epsilon && Math.abs(edge.to.x) <= epsilon)
    || (Math.abs(edge.from.x - width) <= epsilon && Math.abs(edge.to.x - width) <= epsilon)
    || (Math.abs(edge.from.y) <= epsilon && Math.abs(edge.to.y) <= epsilon)
    || (Math.abs(edge.from.y - height) <= epsilon && Math.abs(edge.to.y - height) <= epsilon)
  );
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
