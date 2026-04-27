/*
 * WHAT: Define the canonical map object shared by generation, replay, and rendering.
 * HOW: Create initial maps, normalize Voronoi geometry into canonical cells/edges, and snapshot states for frames.
 * WHY: A single stable shape keeps step modules small and prevents renderer-facing ad hoc fields from spreading.
 */

import { cross } from "./geometry.js";

export const BLANK_STEP_INDEX = -1;
export const DEFAULT_SEGMENT_LENGTH = 10;

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
        primaryRiverWidth: options.primaryRiverWidth,
        tributarySourceRiverDistance: options.tributarySourceRiverDistance,
        tributaryMergeSeaDistance: options.tributaryMergeSeaDistance,
        tributaryWidthRatio: options.tributaryWidthRatio,
        primaryMergeWidthGain: options.primaryMergeWidthGain,
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

function snapshotMap(map) {
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
        id: cell.site.id ?? cell.id,
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

export function convertCellGeometryToLotGeometry(map, segmentLength = DEFAULT_SEGMENT_LENGTH) {
  if (Array.isArray(map.lots) && Array.isArray(map.segments) && !map.cells?.length && !map.edges?.length) {
    return map;
  }

  const cells = map.cells || [];
  const edges = map.edges || [];
  const lots = cells.map((cell) => ({
    id: cell.id,
    site: clonePoint(cell.site),
    centroid: clonePoint(cell.centroid),
    polygon: cell.polygon.map((point) => clonePoint(point)),
    segmentIds: [],
    neighborLotIds: [],
    boundarySides: [...(cell.boundarySides || [])],
    features: {
      ...cell.features,
    },
  }));
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const segments = [];

  edges.forEach((edge) => {
    const path = normalizePolyline(edge.path?.length ? edge.path : [edge.from, edge.to]);
    const edgeLength = polylineLength(path);
    const resolvedSegmentCount = Math.max(1, Math.round(edgeLength / segmentLength));
    const sampledPoints = resamplePolyline(path, resolvedSegmentCount);
    const leftLotId = edge.leftCellId;
    const rightLotId = edge.rightCellId;

    for (let index = 0; index < resolvedSegmentCount; index += 1) {
      const from = sampledPoints[index];
      const to = sampledPoints[index + 1];
      const segment = {
        id: `${edge.id}:${index}`,
        edgeId: edge.id,
        from: clonePoint(from),
        to: clonePoint(to),
        midpoint: midpointBetween(from, to),
        length: pointDistance(from, to),
        leftLotId,
        rightLotId,
        features: {
          boundary: Boolean(edge.features?.boundary),
          sea: Boolean(edge.features?.sea),
          river: Boolean(edge.features?.river),
        },
      };
      segments.push(segment);
      if (leftLotId !== null) {
        lotById.get(leftLotId)?.segmentIds.push(segment.id);
      }
      if (rightLotId !== null && rightLotId !== leftLotId) {
        lotById.get(rightLotId)?.segmentIds.push(segment.id);
      }
    }

    if (leftLotId !== null && rightLotId !== null) {
      const leftLot = lotById.get(leftLotId);
      const rightLot = lotById.get(rightLotId);
      if (leftLot && !leftLot.neighborLotIds.includes(rightLotId)) {
        leftLot.neighborLotIds.push(rightLotId);
      }
      if (rightLot && !rightLot.neighborLotIds.includes(leftLotId)) {
        rightLot.neighborLotIds.push(leftLotId);
      }
    }
  });

  lots.forEach((lot) => {
    lot.neighborLotIds.sort((first, second) => first - second);
  });

  const { cells: _cells, edges: _edges, ...rest } = map;
  return {
    ...rest,
    lots,
    segments,
  };
}

export function getMapGeometry(map) {
  return {
    lots: Array.isArray(map.lots) ? map.lots : map.cells || [],
    segments: Array.isArray(map.segments) ? map.segments : map.edges || [],
  };
}

export function getMapLots(map) {
  return getMapGeometry(map).lots;
}

export function clearTemporaryHillFeatures(map) {
  if (!Array.isArray(map.cells) || !map.cells.length) {
    return map;
  }

  return {
    ...map,
    cells: map.cells.map((cell) => ({
      ...cell,
      features: {
        ...cell.features,
        hill: false,
        hillside: false,
      },
    })),
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
      from: clonePoint(edge.from),
      to: clonePoint(edge.to),
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
    from: clonePoint(edge.from),
    to: clonePoint(edge.to),
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

export function normalizePolyline(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const normalized = points
    .filter(Boolean)
    .map((point) => clonePoint(point));
  return dedupeConsecutivePoints(normalized);
}

export function resamplePolyline(points, segmentCount) {
  if (points.length === 0) {
    return Array.from({ length: segmentCount + 1 }, () => ({ x: 0, y: 0 }));
  }

  if (points.length === 1) {
    return Array.from({ length: segmentCount + 1 }, () => clonePoint(points[0]));
  }

  const cumulativeDistances = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulativeDistances[index] = cumulativeDistances[index - 1] + pointDistance(points[index - 1], points[index]);
  }

  const totalLength = cumulativeDistances[cumulativeDistances.length - 1];
  if (totalLength === 0) {
    return Array.from({ length: segmentCount + 1 }, () => clonePoint(points[0]));
  }

  const sampledPoints = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const targetDistance = (totalLength * index) / segmentCount;
    sampledPoints.push(pointAlongPolyline(points, cumulativeDistances, targetDistance));
  }

  sampledPoints[0] = clonePoint(points[0]);
  sampledPoints[sampledPoints.length - 1] = clonePoint(points[points.length - 1]);
  return sampledPoints;
}

function pointAlongPolyline(points, cumulativeDistances, targetDistance) {
  const totalLength = cumulativeDistances[cumulativeDistances.length - 1];
  if (targetDistance <= 0) {
    return clonePoint(points[0]);
  }
  if (targetDistance >= totalLength) {
    return clonePoint(points[points.length - 1]);
  }

  for (let index = 1; index < cumulativeDistances.length; index += 1) {
    if (targetDistance > cumulativeDistances[index]) {
      continue;
    }

    const segmentStart = points[index - 1];
    const segmentEnd = points[index];
    const segmentLength = cumulativeDistances[index] - cumulativeDistances[index - 1];
    if (segmentLength === 0) {
      return clonePoint(segmentEnd);
    }

    const localT = (targetDistance - cumulativeDistances[index - 1]) / segmentLength;
    return {
      x: segmentStart.x + (segmentEnd.x - segmentStart.x) * localT,
      y: segmentStart.y + (segmentEnd.y - segmentStart.y) * localT,
    };
  }

  return clonePoint(points[points.length - 1]);
}

export function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += pointDistance(points[index - 1], points[index]);
  }
  return length;
}

export function dedupeConsecutivePoints(points) {
  const deduped = [];
  points.forEach((point) => {
    const previous = deduped[deduped.length - 1];
    if (!previous || pointDistance(previous, point) > 0.0001) {
      deduped.push(point);
    }
  });
  return deduped;
}

export function midpointBetween(first, second) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

export function pointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function clonePoint(point) {
  const cloned = {
    x: point.x,
    y: point.y,
  };
  if (point.id !== undefined) {
    cloned.id = point.id;
  }
  return cloned;
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
