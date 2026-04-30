/*
 * WHAT: Build sampled coastline paths from land/sea Voronoi boundaries.
 * HOW: Trace adjacent coast edges into chains, smooth each shared vertex with a quadratic Bezier,
 *      and expose both production edge paths and tutorial-friendly trace data.
 * WHY: The map model stays segment-only while coastline construction remains inspectable.
 */

const POINT_KEY_DIGITS = 4;
const EPSILON = 0.0001;

export function buildCoastlineTrace(map, { segmentLength = 15 } = {}) {
  const cells = map.cells || [];
  const edges = map.edges || [];
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const coastEdges = edges
    .map((edge) => createCoastEdge(edge, cellById))
    .filter(Boolean)
    .sort((first, second) => String(first.id).localeCompare(String(second.id)));
  const coastEdgeById = new Map(coastEdges.map((edge) => [edge.id, edge]));
  const chains = traceCoastChains(coastEdges, coastEdgeById);
  const edgePathById = new Map();
  const replacementPointByVertexKey = new Map();
  const curves = [];

  coastEdges.forEach((edge) => {
    edge.endpointToMidpointPath = new Map();
    edge.midpointToEndpointPath = new Map();
  });

  chains.forEach((chain, chainIndex) => {
    const chainCurves = buildChainBezierPaths(chain, coastEdgeById, segmentLength, chainIndex, replacementPointByVertexKey);
    curves.push(...chainCurves);
  });

  coastEdges.forEach((edge) => {
    const fromKey = pointKey(edge.from);
    const toKey = pointKey(edge.to);
    const firstHalf = edge.endpointToMidpointPath.get(fromKey) || [edge.from, edge.midpoint];
    const secondHalf = edge.midpointToEndpointPath.get(toKey) || [edge.midpoint, edge.to];
    edgePathById.set(edge.id, dedupeConsecutivePoints([...firstHalf, ...secondHalf.slice(1)]));
  });

  return {
    coastEdges,
    chains,
    curves,
    edgePathById,
    replacementPointByVertexKey,
  };
}

function createCoastEdge(edge, cellById) {
  const leftCell = edge.leftCellId === null ? null : cellById.get(edge.leftCellId);
  const rightCell = edge.rightCellId === null ? null : cellById.get(edge.rightCellId);
  const leftSea = Boolean(leftCell?.features?.sea);
  const rightSea = Boolean(rightCell?.features?.sea);
  const hasLand = Boolean(leftCell?.features?.land || rightCell?.features?.land);
  const hasSea = Boolean(leftSea || rightSea);

  if (!hasLand || !hasSea || leftSea === rightSea) {
    return null;
  }

  return {
    id: edge.id,
    edge,
    from: clonePoint(edge.from),
    to: clonePoint(edge.to),
    midpoint: edge.midpoint ? clonePoint(edge.midpoint) : midpointBetween(edge.from, edge.to),
    fromKey: pointKey(edge.from),
    toKey: pointKey(edge.to),
  };
}

function traceCoastChains(coastEdges, coastEdgeById) {
  const edgeIdsByVertexKey = new Map();
  coastEdges.forEach((edge) => {
    pushMapValue(edgeIdsByVertexKey, edge.fromKey, edge.id);
    pushMapValue(edgeIdsByVertexKey, edge.toKey, edge.id);
  });
  edgeIdsByVertexKey.forEach((edgeIds) => {
    edgeIds.sort((first, second) => String(first).localeCompare(String(second)));
  });

  const visitedEdgeIds = new Set();
  const chains = [];
  const openStarts = Array.from(edgeIdsByVertexKey.entries())
    .filter(([, edgeIds]) => edgeIds.length === 1)
    .sort(([first], [second]) => first.localeCompare(second));

  openStarts.forEach(([vertexKey, edgeIds]) => {
    if (!visitedEdgeIds.has(edgeIds[0])) {
      chains.push(traceChain(vertexKey, edgeIds[0], edgeIdsByVertexKey, coastEdgeById, visitedEdgeIds));
    }
  });

  coastEdges.forEach((edge) => {
    if (!visitedEdgeIds.has(edge.id)) {
      chains.push(traceChain(edge.fromKey, edge.id, edgeIdsByVertexKey, coastEdgeById, visitedEdgeIds));
    }
  });

  return chains.map((chain, index) => ({
    ...chain,
    id: `coast-chain:${index}`,
    closed: chain.vertexKeys.length > 2 && chain.vertexKeys[0] === chain.vertexKeys[chain.vertexKeys.length - 1],
  }));
}

function traceChain(startVertexKey, startEdgeId, edgeIdsByVertexKey, coastEdgeById, visitedEdgeIds) {
  const vertexKeys = [startVertexKey];
  const edgeIds = [];
  let currentVertexKey = startVertexKey;
  let currentEdgeId = startEdgeId;

  while (currentEdgeId !== null && currentEdgeId !== undefined && !visitedEdgeIds.has(currentEdgeId)) {
    const edge = coastEdgeById.get(currentEdgeId);
    if (!edge) {
      break;
    }
    visitedEdgeIds.add(currentEdgeId);
    edgeIds.push(currentEdgeId);
    const nextVertexKey = edge.fromKey === currentVertexKey ? edge.toKey : edge.fromKey;
    vertexKeys.push(nextVertexKey);

    if (nextVertexKey === startVertexKey) {
      break;
    }

    const nextEdgeId = (edgeIdsByVertexKey.get(nextVertexKey) || [])
      .find((edgeId) => edgeId !== currentEdgeId && !visitedEdgeIds.has(edgeId));
    currentVertexKey = nextVertexKey;
    currentEdgeId = nextEdgeId;
  }

  return { vertexKeys, edgeIds };
}

function buildChainBezierPaths(chain, coastEdgeById, segmentLength, chainIndex, replacementPointByVertexKey) {
  const curves = [];
  const closed = chain.vertexKeys[0] === chain.vertexKeys[chain.vertexKeys.length - 1];
  const vertexCount = closed ? chain.vertexKeys.length - 1 : chain.vertexKeys.length;

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const vertexKey = chain.vertexKeys[vertexIndex];
    const control = pointFromKey(vertexKey);
    const previousEdgeId = vertexIndex === 0
      ? closed ? chain.edgeIds[chain.edgeIds.length - 1] : null
      : chain.edgeIds[vertexIndex - 1];
    const nextEdgeId = vertexIndex >= chain.edgeIds.length
      ? closed ? chain.edgeIds[0] : null
      : chain.edgeIds[vertexIndex];
    const previousEdge = previousEdgeId === null ? null : coastEdgeById.get(previousEdgeId);
    const nextEdge = nextEdgeId === null ? null : coastEdgeById.get(nextEdgeId);

    if (!previousEdge && !nextEdge) {
      continue;
    }

    const start = previousEdge ? previousEdge.midpoint : mirrorPoint(nextEdge.midpoint, control);
    const end = nextEdge ? nextEdge.midpoint : mirrorPoint(previousEdge.midpoint, control);
    const sampled = sampleQuadraticBezier(start, control, end, segmentLength);
    const nearestIndex = findNearestPointIndex(sampled, control);
    const nearControl = sampled[nearestIndex];
    replacementPointByVertexKey.set(vertexKey, nearControl);

    if (previousEdge) {
      const midpointToEndpoint = sampled.slice(0, nearestIndex + 1);
      previousEdge.midpointToEndpointPath.set(vertexKey, midpointToEndpoint);
      previousEdge.endpointToMidpointPath.set(vertexKey, [...midpointToEndpoint].reverse());
    }
    if (nextEdge) {
      const endpointToMidpoint = sampled.slice(nearestIndex);
      nextEdge.endpointToMidpointPath.set(vertexKey, endpointToMidpoint);
      nextEdge.midpointToEndpointPath.set(vertexKey, [...endpointToMidpoint].reverse());
    }

    curves.push({
      id: `coast-curve:${chainIndex}:${vertexIndex}`,
      chainId: chain.id,
      start,
      control,
      end,
      nearest: nearControl,
      points: sampled,
      previousEdgeId,
      nextEdgeId,
    });
  }

  return curves;
}

function sampleQuadraticBezier(start, control, end, segmentLength) {
  const approximateLength = pointDistance(start, control) + pointDistance(control, end);
  const segmentCount = Math.max(2, Math.round(approximateLength / Math.max(EPSILON, segmentLength)));
  const points = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const t = index / segmentCount;
    const inverse = 1 - t;
    points.push({
      x: (inverse * inverse * start.x) + (2 * inverse * t * control.x) + (t * t * end.x),
      y: (inverse * inverse * start.y) + (2 * inverse * t * control.y) + (t * t * end.y),
    });
  }
  return dedupeConsecutivePoints(points);
}

function findNearestPointIndex(points, target) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = pointDistance(point, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function pushMapValue(map, key, value) {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}

function pointFromKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function midpointBetween(first, second) {
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

function pointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clonePoint(point) {
  return { x: point.x, y: point.y };
}

function dedupeConsecutivePoints(points) {
  const deduped = [];
  points.forEach((point) => {
    const previous = deduped[deduped.length - 1];
    if (!previous || pointDistance(previous, point) > EPSILON) {
      deduped.push(point);
    }
  });
  return deduped;
}
