/*
 * WHAT: Define the canonical map object shared by generation, replay, and rendering.
 * HOW: Create initial maps, normalize Voronoi geometry into canonical cells/edges, and snapshot states for frames.
 * WHY: A single stable shape keeps step modules small and prevents renderer-facing ad hoc fields from spreading.
 */

import { cross } from "./geometry.js";
import { buildCoastlineTrace } from "./coastline-model.js";
import { buildParishBorderTrace } from "./parish-border-model.js";

export const BLANK_STEP_INDEX = -1;
export const DEFAULT_SEGMENT_LENGTH = 20;

const SNAPSHOT_FALLBACK = (value) => JSON.parse(JSON.stringify(value));

export function createInitialMap(options) {
  return {
    init: {
      seed: options.seed,
      params: {
        seed: options.seed,
        pointCount: options.pointCount,
        scatterPaddingRatio: options.scatterPaddingRatio,
        stepAlgorithms: {
          ...(options.stepAlgorithms || {}),
        },
        poissonSpacingRatio: options.poissonSpacingRatio,
        poissonMaxAttempts: options.poissonMaxAttempts,
        poissonPaddingRatio: options.poissonPaddingRatio,
        waterReachRatio: options.waterReachRatio,
        waterExpansionBase: options.waterExpansionBase,
        waterExpansionEdgeWeight: options.waterExpansionEdgeWeight,
        waterPressureRangeRatio: options.waterPressureRangeRatio,
        waterCenterBiasRadiusRatio: options.waterCenterBiasRadiusRatio,
        relaxPaddingRatio: options.relaxPaddingRatio,
        collapseShortEdgeLength: options.collapseShortEdgeLength,
        primaryRiverWidth: options.primaryRiverWidth,
        primaryRiverTurnAngleDegrees: options.primaryRiverTurnAngleDegrees,
        tributaryRiverTurnAngleDegrees: options.tributaryRiverTurnAngleDegrees,
        tributaryWidthRatio: options.tributaryWidthRatio,
        primaryMergeWidthGain: options.primaryMergeWidthGain,
        parishCount: options.parishCount,
        routeCrossingCost: options.routeCrossingCost,
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
    vertices: [],
    cells: [],
    edges: [],
    rivers: [],
    river: {
      primary: null,
      secondary: null,
    },
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
  const vertices = [];
  const vertexByKey = new Map();
  const cells = diagram.cells.map((cell) => {
    const boundarySides = Object.entries(cell.touches)
      .filter(([, touched]) => touched)
      .map(([side]) => side);
    const vertexIds = cell.polygon.map((point) => getOrCreateGeometryVertex(vertices, vertexByKey, point));

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
      vertexIds,
      edgeIds: [],
      neighborCellIds: [],
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
    const oriented = orientEdge(edge, cellById, diagram.width, diagram.height);
    const fromVertexId = getOrCreateGeometryVertex(vertices, vertexByKey, oriented.from);
    const toVertexId = getOrCreateGeometryVertex(vertices, vertexByKey, oriented.to);
    oriented.fromVertexId = fromVertexId;
    oriented.toVertexId = toVertexId;
    vertices[fromVertexId].edgeIds.push(oriented.id);
    vertices[toVertexId].edgeIds.push(oriented.id);
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

  return { vertices, cells, edges };
}

export function convertCellGeometryToLotGeometry(map, segmentLength = DEFAULT_SEGMENT_LENGTH) {
  return convertCellGeometryToLotGeometryWithEdgeSampler(map, (edge, lotById, edgeLength) => {
    const path = normalizePolyline(edge.path?.length ? edge.path : [edge.from, edge.to]);
    const resolvedSegmentCount = Math.max(1, Math.round(edgeLength / segmentLength));
    return resamplePolyline(path, resolvedSegmentCount);
  });
}

export function convertCellGeometryToCoastlineLotGeometry(map, segmentLength = DEFAULT_SEGMENT_LENGTH) {
  if (Array.isArray(map.lots) && Array.isArray(map.segments) && !map.cells?.length && !map.edges?.length) {
    return map;
  }

  const coastlineTrace = buildCoastlineTrace(map, { segmentLength });
  return convertCellGeometryToLotGeometryWithEdgeSampler(map, (edge, lotById, edgeLength) => {
    const coastlinePath = coastlineTrace.edgePathById.get(edge.id);
    if (coastlinePath) {
      return coastlinePath;
    }

    const from = coastlineTrace.replacementPointByVertexKey.get(pointKey(edge.from)) || edge.from;
    const to = coastlineTrace.replacementPointByVertexKey.get(pointKey(edge.to)) || edge.to;
    return normalizePolyline(edge.path?.length ? edge.path : [from, to]);
  });
}

export function convertLotGeometryToParishBorderGeometry(map, segmentLength = DEFAULT_SEGMENT_LENGTH) {
  return convertLotGeometryWithParishBorders(map, segmentLength, {
    segmentLandEdges: false,
  });
}

export function convertLotGeometryToLandEdgeGeometry(map, segmentLength = DEFAULT_SEGMENT_LENGTH) {
  return convertLotGeometryWithParishBorders(map, segmentLength, {
    applyParishBorders: true,
    segmentLandEdges: true,
  });
}

export function convertLotGeometryToLandEdgeSegmentation(map, segmentLength = DEFAULT_SEGMENT_LENGTH) {
  return convertLotGeometryWithParishBorders(map, segmentLength, {
    applyParishBorders: false,
    segmentLandEdges: true,
  });
}

function convertLotGeometryWithParishBorders(map, segmentLength = DEFAULT_SEGMENT_LENGTH, { applyParishBorders = true, segmentLandEdges = true } = {}) {
  if (!Array.isArray(map.lots) || !Array.isArray(map.segments)) {
    return map;
  }

  const lots = (map.lots || []).map((lot) => ({
    ...lot,
    segmentIds: [],
    neighborLotIds: [],
    vertexIds: [],
  }));
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const vertices = [];
  const vertexByKey = new Map();
  const segments = [];
  const segmentPathById = new Map();
  const parishBorderTrace = applyParishBorders
    ? buildParishBorderTrace(map, { segmentLength })
    : createEmptyParishBorderTrace();

  (map.segments || []).forEach((segment) => {
    const replacementPath = parishBorderTrace.edgePathById.get(segment.id);
    const from = parishBorderTrace.replacementPointByVertexKey.get(pointKey(segment.from)) || segment.from;
    const to = parishBorderTrace.replacementPointByVertexKey.get(pointKey(segment.to)) || segment.to;
    const path = normalizePolyline(replacementPath || replacePathEndpoints(segment.path?.length ? segment.path : [segment.from, segment.to], from, to));
    const keepAsIs = Boolean(segment.features?.coast) || Boolean(segment.features?.sea);
    const isParishBoundarySmoothed = parishBorderTrace.smoothedSegmentIds.has(segment.id) || Boolean(segment.features?.parishBoundarySmoothed);
    const preservePath = keepAsIs || isParishBoundarySmoothed;
    const sampledPoints = preservePath || !segmentLandEdges
      ? path
      : resamplePolyline(path, Math.max(1, Math.ceil(polylineLength(path) / segmentLength)));
    segmentPathById.set(segment.id, sampledPoints);

    for (let index = 0; index < sampledPoints.length - 1; index += 1) {
      const from = sampledPoints[index];
      const to = sampledPoints[index + 1];
      const fromVertexId = getOrCreateLotVertex(vertices, vertexByKey, from);
      const toVertexId = getOrCreateLotVertex(vertices, vertexByKey, to);
      const leftLotId = segment.leftLotId;
      const rightLotId = segment.rightLotId;
      const nextSegment = {
        id: `${segment.id}:${index}`,
        edgeId: segment.edgeId || segment.id,
        fromVertexId,
        toVertexId,
        from: clonePoint(from),
        to: clonePoint(to),
        midpoint: midpointBetween(from, to),
        length: pointDistance(from, to),
        leftLotId,
        rightLotId,
        features: {
          ...segment.features,
          parishBoundary: parishBorderTrace.parishBoundarySegmentIds.has(segment.id) || Boolean(segment.features?.parishBoundary),
          parishBoundarySmoothed: isParishBoundarySmoothed,
          sea: keepAsIs && Boolean(segment.features?.sea),
        },
      };
      segments.push(nextSegment);
      vertices[fromVertexId].segmentIds.push(nextSegment.id);
      vertices[toVertexId].segmentIds.push(nextSegment.id);
      if (leftLotId !== null) {
        lotById.get(leftLotId)?.segmentIds.push(nextSegment.id);
      }
      if (rightLotId !== null && rightLotId !== leftLotId) {
        lotById.get(rightLotId)?.segmentIds.push(nextSegment.id);
      }
    }
  });

  rebuildLotPolygonsFromSegmentPaths(lots, map.segments || [], segmentPathById);
  rebuildLotRelationships(lots, lotById, segments);
  lots.forEach((lot) => {
    lot.vertexIds = lot.polygon.map((point) => getOrCreateLotVertex(vertices, vertexByKey, point));
  });
  applyVertexFeaturesFromSegments(vertices, segments);
  return {
    ...stripCellGeometry(map),
    vertices,
    lots,
    segments,
  };
}

function createEmptyParishBorderTrace() {
  return {
    edgePathById: new Map(),
    replacementPointByVertexKey: new Map(),
    parishBoundarySegmentIds: new Set(),
    smoothedSegmentIds: new Set(),
  };
}

function rebuildLotPolygonsFromSegmentPaths(lots, sourceSegments, segmentPathById) {
  const segmentEntries = sourceSegments.map((segment) => ({
    segment,
    fromKey: pointKey(segment.from),
    toKey: pointKey(segment.to),
  }));

  lots.forEach((lot) => {
    if (!Array.isArray(lot.polygon) || lot.polygon.length < 3) {
      return;
    }

    const polygon = [];
    for (let index = 0; index < lot.polygon.length; index += 1) {
      const from = lot.polygon[index];
      const to = lot.polygon[(index + 1) % lot.polygon.length];
      const fromKey = pointKey(from);
      const toKey = pointKey(to);
      const entry = segmentEntries.find(({ fromKey: segmentFromKey, toKey: segmentToKey }) =>
        (segmentFromKey === fromKey && segmentToKey === toKey) || (segmentFromKey === toKey && segmentToKey === fromKey)
      );
      const segmentPath = entry ? segmentPathById.get(entry.segment.id) : null;
      const path = segmentPath
        ? orientPathForEndpoints(segmentPath, from, to)
        : [clonePoint(from), clonePoint(to)];
      appendPath(polygon, path);
    }
    lot.polygon = dedupeConsecutivePoints(polygon);
  });
}

function convertCellGeometryToLotGeometryWithEdgeSampler(map, sampleEdgePath) {
  const cells = map.cells || [];
  const edges = map.edges || [];
  const vertices = [];
  const vertexByKey = new Map();
  const lots = cells.map((cell) => ({
    id: cell.id,
    site: clonePoint(cell.site),
    centroid: clonePoint(cell.centroid),
    polygon: cell.polygon.map((point) => clonePoint(point)),
    vertexIds: [],
    segmentIds: [],
    neighborLotIds: [],
    boundarySides: [...(cell.boundarySides || [])],
    features: lotFeaturesFromCell(cell),
  }));
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const segments = [];
  const edgePathById = new Map();

  edges.forEach((edge) => {
    const path = sampleEdgePath(edge, lotById, polylineLength(normalizePolyline(edge.path?.length ? edge.path : [edge.from, edge.to])));
    edgePathById.set(edge.id, path);
    const leftLotId = edge.leftCellId;
    const rightLotId = edge.rightCellId;
    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index];
      const to = path[index + 1];
      const fromVertexId = getOrCreateLotVertex(vertices, vertexByKey, from);
      const toVertexId = getOrCreateLotVertex(vertices, vertexByKey, to);
      const features = buildLotBoundaryFeatures(edge, lotById);
      const segment = {
        id: `${edge.id}:${index}`,
        edgeId: edge.id,
        fromVertexId,
        toVertexId,
        from: clonePoint(from),
        to: clonePoint(to),
        midpoint: midpointBetween(from, to),
        length: pointDistance(from, to),
        leftLotId,
        rightLotId,
        features,
      };
      segments.push(segment);
      vertices[fromVertexId].segmentIds.push(segment.id);
      vertices[toVertexId].segmentIds.push(segment.id);
      if (leftLotId !== null) {
        lotById.get(leftLotId)?.segmentIds.push(segment.id);
      }
      if (rightLotId !== null && rightLotId !== leftLotId) {
        lotById.get(rightLotId)?.segmentIds.push(segment.id);
      }
    }
  });

  rebuildLotPolygonsFromEdgePaths(lots, cells, edges, edgePathById);
  lots.forEach((lot) => {
    lot.vertexIds = lot.polygon.map((point) => getOrCreateLotVertex(vertices, vertexByKey, point));
  });
  rebuildLotRelationships(lots, lotById, segments);
  applyVertexFeaturesFromSegments(vertices, segments);
  return {
    ...stripCellGeometry(map),
    vertices,
    lots,
    segments,
  };
}

function rebuildLotPolygonsFromEdgePaths(lots, cells, edges, edgePathById) {
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const edgeEntries = edges.map((edge) => ({
    edge,
    fromKey: pointKey(edge.from),
    toKey: pointKey(edge.to),
  }));

  cells.forEach((cell) => {
    const lot = lotById.get(cell.id);
    if (!lot || !Array.isArray(cell.polygon) || cell.polygon.length < 3) {
      return;
    }

    const polygon = [];
    for (let index = 0; index < cell.polygon.length; index += 1) {
      const from = cell.polygon[index];
      const to = cell.polygon[(index + 1) % cell.polygon.length];
      const fromKey = pointKey(from);
      const toKey = pointKey(to);
      const entry = edgeEntries.find(({ fromKey: edgeFromKey, toKey: edgeToKey }) =>
        (edgeFromKey === fromKey && edgeToKey === toKey) || (edgeFromKey === toKey && edgeToKey === fromKey)
      );
      const edgePath = entry ? edgePathById.get(entry.edge.id) : null;
      const path = edgePath
        ? orientPathForEndpoints(edgePath, from, to)
        : [clonePoint(from), clonePoint(to)];
      appendPath(polygon, path);
    }
    lot.polygon = dedupeConsecutivePoints(polygon);
  });
}

function orientPathForEndpoints(path, from, to) {
  if (!path?.length) {
    return [clonePoint(from), clonePoint(to)];
  }

  const first = path[0];
  const last = path[path.length - 1];
  const forwardDistance = pointDistance(first, from) + pointDistance(last, to);
  const reverseDistance = pointDistance(last, from) + pointDistance(first, to);
  const oriented = forwardDistance <= reverseDistance ? path : [...path].reverse();
  return oriented.map((point) => clonePoint(point));
}

function replacePathEndpoints(path, from, to) {
  if (!Array.isArray(path) || !path.length) {
    return [clonePoint(from), clonePoint(to)];
  }

  const replaced = path.map((point) => clonePoint(point));
  replaced[0] = clonePoint(from);
  replaced[replaced.length - 1] = clonePoint(to);
  return replaced;
}

function appendPath(target, path) {
  path.forEach((point, index) => {
    const previous = target[target.length - 1];
    if (index > 0 && previous && pointDistance(previous, point) <= 0.0001) {
      return;
    }
    target.push(clonePoint(point));
  });
}

function rebuildLotRelationships(lots, lotById, segments) {
  lots.forEach((lot) => {
    lot.neighborLotIds = [];
  });
  segments.forEach((segment) => {
    if (segment.leftLotId !== null && segment.rightLotId !== null) {
      const leftLot = lotById.get(segment.leftLotId);
      const rightLot = lotById.get(segment.rightLotId);
      if (leftLot && !leftLot.neighborLotIds.includes(segment.rightLotId)) {
        leftLot.neighborLotIds.push(segment.rightLotId);
      }
      if (rightLot && !rightLot.neighborLotIds.includes(segment.leftLotId)) {
        rightLot.neighborLotIds.push(segment.leftLotId);
      }
    }
  });
  lots.forEach((lot) => {
    lot.neighborLotIds.sort((first, second) => first - second);
  });
}

function stripCellGeometry(map) {
  const { cells: _cells, edges: _edges, vertices: _cellVertices, ...rest } = map;
  return rest;
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

function getOrCreateGeometryVertex(vertices, vertexByKey, point) {
  const key = pointKey(point);
  const existingId = vertexByKey.get(key);
  if (existingId !== undefined) {
    return existingId;
  }

  const id = vertices.length;
  vertices.push({
    id,
    x: point.x,
    y: point.y,
    edgeIds: [],
  });
  vertexByKey.set(key, id);
  return id;
}

function getOrCreateLotVertex(vertices, vertexByKey, point) {
  const key = pointKey(point);
  const existingId = vertexByKey.get(key);
  if (existingId !== undefined) {
    return existingId;
  }

  const id = vertices.length;
  vertices.push({
    id,
    x: point.x,
    y: point.y,
    segmentIds: [],
    features: {
      coast: false,
      land: false,
      sea: false,
      riverside: false,
    },
  });
  vertexByKey.set(key, id);
  return id;
}

function buildLotBoundaryFeatures(edge, lotById) {
  const leftLot = edge.leftCellId === null ? null : lotById.get(edge.leftCellId);
  const rightLot = edge.rightCellId === null ? null : lotById.get(edge.rightCellId);
  const leftSea = Boolean(leftLot?.features.sea);
  const rightSea = Boolean(rightLot?.features.sea);
  const hasLand = Boolean(leftLot?.features.land || rightLot?.features.land);
  const hasSea = Boolean(leftSea || rightSea);
  const coast = Boolean(hasLand && hasSea && leftSea !== rightSea);

  return {
    boundary: Boolean(edge.features?.boundary),
    coast,
    land: hasLand && !coast,
    sea: Boolean(leftSea && rightSea),
    river: Boolean(edge.features?.river),
    riverside: false,
  };
}

function lotFeaturesFromCell(cell) {
  return { ...(cell.features || {}) };
}

function applyVertexFeaturesFromSegments(vertices, segments) {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  vertices.forEach((vertex) => {
    const featureList = vertex.segmentIds.map((segmentId) => segmentById.get(segmentId)?.features).filter(Boolean);
    vertex.features = {
      coast: featureList.some((features) => features.coast),
      land: featureList.some((features) => features.land || features.coast),
      sea: featureList.some((features) => features.sea),
      riverside: featureList.some((features) => features.riverside),
      bridge: featureList.some((features) => features.bridge),
    };
  });
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
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

function liesOnCanvasBoundary(edge, width, height, epsilon = 2.25) {
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
