/*
 * WHAT: Build smoothed replacement paths for inter-parish lot-boundary segments.
 * HOW: Trace same-parish-pair boundary chains, pin protected/junction endpoints, and smooth
 *      multi-segment chains with the shared pinned-polyline sampler.
 * WHY: Parish borders should become canonical sampled geometry before later land and field steps.
 */

import { clonePoint, normalizePolyline } from "./map-model.js";
import { inspectPinnedPolylineSmoothing } from "./polyline-smoothing.js";

const POINT_KEY_DIGITS = 4;

export function buildParishBorderTrace(map, { segmentLength } = {}) {
  const lots = map.lots || [];
  const segments = map.segments || [];
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const pointByKey = new Map();
  const protectedVertexKeys = new Set();
  const parishBoundarySegmentIds = new Set();
  const smoothedSegmentIds = new Set();
  const edgePathById = new Map();
  const replacementPointByVertexKey = new Map();
  const candidateSegmentsByPairKey = new Map();
  const parishBorderUsageByVertexKey = new Map();
  const chains = [];

  segments.forEach((segment) => {
    const fromKey = pointKey(segment.from);
    const toKey = pointKey(segment.to);
    pointByKey.set(fromKey, clonePoint(segment.from));
    pointByKey.set(toKey, clonePoint(segment.to));
    if (segment.features?.boundary || segment.features?.coast || segment.features?.sea || segment.features?.river) {
      protectedVertexKeys.add(fromKey);
      protectedVertexKeys.add(toKey);
    }

    const leftLot = segment.leftLotId === null || segment.leftLotId === undefined ? null : lotById.get(segment.leftLotId);
    const rightLot = segment.rightLotId === null || segment.rightLotId === undefined ? null : lotById.get(segment.rightLotId);
    const leftParishId = leftLot?.parishId;
    const rightParishId = rightLot?.parishId;
    if (
      leftParishId === null || leftParishId === undefined
      || rightParishId === null || rightParishId === undefined
      || leftParishId === rightParishId
      || segment.features?.coast
      || segment.features?.sea
      || segment.features?.river
    ) {
      return;
    }

    parishBoundarySegmentIds.add(segment.id);
    const pairKey = parishPairKey(leftParishId, rightParishId);
    const candidates = candidateSegmentsByPairKey.get(pairKey) || [];
    candidates.push({
      id: segment.id,
      fromKey,
      toKey,
    });
    candidateSegmentsByPairKey.set(pairKey, candidates);
    registerParishBorderUsage(parishBorderUsageByVertexKey, fromKey, leftParishId, rightParishId);
    registerParishBorderUsage(parishBorderUsageByVertexKey, toKey, leftParishId, rightParishId);
  });
  parishBorderUsageByVertexKey.forEach((usage, vertexKey) => {
    if (usage.segmentCount > 2 || usage.parishIds.size > 2) {
      protectedVertexKeys.add(vertexKey);
    }
  });

  candidateSegmentsByPairKey.forEach((candidateSegments) => {
    const adjacency = new Map();
    const segmentById = new Map();
    candidateSegments.forEach((segment) => {
      segmentById.set(segment.id, segment);
      pushMapValue(adjacency, segment.fromKey, segment.id);
      pushMapValue(adjacency, segment.toKey, segment.id);
    });
    adjacency.forEach((segmentIds) => {
      segmentIds.sort((first, second) => String(first).localeCompare(String(second)));
    });

    const stopVertexKeys = new Set(
      Array.from(adjacency.entries())
        .filter(([vertexKey, segmentIds]) => protectedVertexKeys.has(vertexKey) || segmentIds.length !== 2)
        .map(([vertexKey]) => vertexKey),
    );
    const visitedSegmentIds = new Set();
    const openStartVertexKeys = Array.from(stopVertexKeys).sort();

    openStartVertexKeys.forEach((vertexKey) => {
      const segmentIds = adjacency.get(vertexKey) || [];
      segmentIds.forEach((segmentId) => {
        if (visitedSegmentIds.has(segmentId)) {
          return;
        }
        const chain = traceParishBorderChain(vertexKey, segmentId, adjacency, segmentById, stopVertexKeys, visitedSegmentIds);
        applyChainPaths(chain);
      });
    });

    Array.from(segmentById.values())
      .sort((first, second) => String(first.id).localeCompare(String(second.id)))
      .forEach((segment) => {
        if (visitedSegmentIds.has(segment.id)) {
          return;
        }
        const startVertexKey = [segment.fromKey, segment.toKey].sort()[0];
        const chain = traceParishBorderChain(startVertexKey, segment.id, adjacency, segmentById, new Set([startVertexKey]), visitedSegmentIds);
        applyChainPaths(chain);
      });
  });

  return {
    edgePathById,
    replacementPointByVertexKey,
    parishBoundarySegmentIds,
    smoothedSegmentIds,
    protectedVertexKeys,
    pointByKey,
    chains,
  };

  function applyChainPaths(chain) {
    chains.push({
      ...chain,
      smoothed: false,
    });
    if (!chain || chain.segmentIds.length < 2) {
      return;
    }

    const points = chain.vertexKeys.map((vertexKey) => pointByKey.get(vertexKey)).filter(Boolean);
    if (points.length !== chain.vertexKeys.length) {
      return;
    }
    const inspection = inspectPinnedPolylineSmoothing(points, protectedVertexKeys, segmentLength);
    const segmentPaths = inspection.segmentPaths;
    if (segmentPaths.length !== chain.segmentIds.length) {
      return;
    }

    chain.segmentIds.forEach((segmentId, index) => {
      const path = normalizePolyline(segmentPaths[index] || []);
      if (path.length < 2) {
        return;
      }
      edgePathById.set(segmentId, path);
      smoothedSegmentIds.add(segmentId);
    });

    chain.vertexKeys.forEach((vertexKey, index) => {
      const replacementPoint = index === 0
        ? segmentPaths[0][0]
        : index === chain.vertexKeys.length - 1
          ? segmentPaths[segmentPaths.length - 1][segmentPaths[segmentPaths.length - 1].length - 1]
          : segmentPaths[index - 1][segmentPaths[index - 1].length - 1];
      if (replacementPoint) {
        replacementPointByVertexKey.set(vertexKey, clonePoint(replacementPoint));
      }
    });
    chains[chains.length - 1].smoothed = true;
    chains[chains.length - 1].segmentPaths = segmentPaths.map((path) => normalizePolyline(path));
    chains[chains.length - 1].curves = inspection.curves;
  }
}

function traceParishBorderChain(startVertexKey, startSegmentId, adjacency, segmentById, stopVertexKeys, visitedSegmentIds) {
  const vertexKeys = [startVertexKey];
  const segmentIds = [];
  let currentVertexKey = startVertexKey;
  let currentSegmentId = startSegmentId;

  while (currentSegmentId !== null && currentSegmentId !== undefined && !visitedSegmentIds.has(currentSegmentId)) {
    const segment = segmentById.get(currentSegmentId);
    if (!segment) {
      break;
    }

    visitedSegmentIds.add(currentSegmentId);
    segmentIds.push(currentSegmentId);
    const nextVertexKey = segment.fromKey === currentVertexKey ? segment.toKey : segment.fromKey;
    vertexKeys.push(nextVertexKey);

    if (nextVertexKey === startVertexKey || stopVertexKeys.has(nextVertexKey)) {
      break;
    }

    const nextSegmentId = (adjacency.get(nextVertexKey) || [])
      .find((segmentId) => segmentId !== currentSegmentId && !visitedSegmentIds.has(segmentId));
    currentVertexKey = nextVertexKey;
    currentSegmentId = nextSegmentId ?? null;
  }

  return { vertexKeys, segmentIds };
}

function parishPairKey(firstParishId, secondParishId) {
  return firstParishId < secondParishId ? `${firstParishId}:${secondParishId}` : `${secondParishId}:${firstParishId}`;
}

function pushMapValue(map, key, value) {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function registerParishBorderUsage(usageByVertexKey, vertexKey, firstParishId, secondParishId) {
  const usage = usageByVertexKey.get(vertexKey) || {
    segmentCount: 0,
    parishIds: new Set(),
  };
  usage.segmentCount += 1;
  usage.parishIds.add(firstParishId);
  usage.parishIds.add(secondParishId);
  usageByVertexKey.set(vertexKey, usage);
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
