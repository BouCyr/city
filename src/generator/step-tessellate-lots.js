/*
 * WHAT: Decompose final lot polygons into clipped Voronoi sublots.
 * HOW: Seed each lot with boundary-fixed sites plus random interior sites, relax interior sites once,
 *      then clip every Voronoi cell back to the lot polygon.
 * WHY: Later altitude work needs a complete bounded subdivision with shared vertices.
 */

import { Delaunay } from "../lib/d3-delaunay/index.js";
import {
  clonePoint,
  midpointBetween,
  pointDistance,
} from "./map-model.js";

const EPSILON = 0.0001;
const POINT_KEY_DIGITS = 4;
const MIN_SUBLOT_AREA = 0.01;
const VORONOI_BOUNDS_PADDING = 20;
const BOUNDARY_SITE_INSET = 1;

export function runTessellateLotsStep(map, { rng }) {
  if (!Array.isArray(map.lots) || !map.lots.length) {
    return {
      map,
      frameEntries: [
        {
          label: "Step 1.10 / Tessellate lot geometry",
          map,
        },
      ],
    };
  }

  const tessellation = buildLotTessellation(map.lots, map.segments || [], rng, map.init?.params?.sublotLloydPasses ?? 2);
  const lotSublotIds = new Map();
  tessellation.sublots.forEach((sublot) => {
    const ids = lotSublotIds.get(sublot.lotId) || [];
    ids.push(sublot.id);
    lotSublotIds.set(sublot.lotId, ids);
  });

  const nextMap = {
    ...map,
    lots: map.lots.map((lot) => ({
      ...lot,
      sublotIds: lotSublotIds.get(lot.id) || [],
    })),
    tessellation,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.10 / Tessellate lot geometry",
        map: nextMap,
      },
    ],
  };
}

function buildLotTessellation(lots, segments, rng, lloydPasses) {
  const vertices = [];
  const vertexByKey = new Map();
  const sublots = [];
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

  lots.forEach((lot) => {
    const polygon = normalizePolygon(lot.polygon || []);
    if (polygon.length < 3 || Math.abs(computeSignedArea(polygon)) <= EPSILON) {
      return;
    }

    const boundarySites = createBoundarySites(lot, segmentById, polygon);
    const boundarySiteCount = Math.max(3, boundarySites.length);
    const totalSiteCount = getTargetSiteCount(lot, boundarySiteCount);
    const sites = [
      ...boundarySites,
      ...createInteriorSites(polygon, Math.max(0, totalSiteCount - boundarySiteCount), rng),
    ];
    let relaxedSites = sites;
    for (let pass = 0; pass < lloydPasses; pass += 1) {
      relaxedSites = relaxInteriorSitesOnce(relaxedSites, polygon);
    }
    const cells = buildClippedVoronoiCells(relaxedSites, polygon);

    cells.forEach((cell) => {
      if (cell.polygon.length < 3 || Math.abs(computeSignedArea(cell.polygon)) < MIN_SUBLOT_AREA) {
        return;
      }

      const vertexIds = cell.polygon.map((point) => getOrCreateVertex(vertices, vertexByKey, point));
      sublots.push({
        id: sublots.length,
        lotId: lot.id,
        siteIndex: cell.siteIndex,
        site: clonePoint(cell.site),
        siteType: cell.siteType,
        vertexIds,
        centroid: computePolygonCentroid(cell.polygon),
        area: Math.abs(computeSignedArea(cell.polygon)),
        features: {
          ...(lot.features || {}),
        },
      });
    });
  });

  return {
    vertices,
    sublots,
  };
}

function getTargetSiteCount(lot, x) {
  const base = lot.features?.sea ? Math.pow(x / 6, 2) : Math.max(x + 4, Math.pow(x / 2, 2) / 3);
  return Math.max(x, Math.round(base));
}

function createBoundarySites(lot, segmentById, polygon) {
  const seen = new Set();
  const sites = [];
  const centroid = computePolygonCentroid(polygon);
  (lot.segmentIds || []).forEach((segmentId) => {
    const segment = segmentById.get(segmentId);
    if (!segment) {
      return;
    }

    const point = insetBoundarySite(midpointBetween(segment.from, segment.to), centroid);
    const key = pointKey(point);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    sites.push({
      ...point,
      siteType: "boundary",
    });
  });

  if (sites.length) {
    return sites;
  }

  return polygon.map((point) => ({
    ...insetBoundarySite(point, centroid),
    siteType: "boundary",
  }));
}

function insetBoundarySite(point, centroid) {
  const distance = pointDistance(point, centroid);
  if (distance <= EPSILON) {
    return clonePoint(point);
  }

  const inset = Math.min(BOUNDARY_SITE_INSET, distance * 0.25);
  const ratio = inset / distance;
  return {
    x: point.x + (centroid.x - point.x) * ratio,
    y: point.y + (centroid.y - point.y) * ratio,
  };
}

function createInteriorSites(polygon, count, rng) {
  const bounds = expandBounds(computeBounds(polygon), VORONOI_BOUNDS_PADDING);
  const sites = [];
  let attempts = 0;
  const maxAttempts = count * 80;

  while (sites.length < count && attempts < maxAttempts) {
    attempts += 1;
    const point = {
      x: rng.between(bounds.minX, bounds.maxX),
      y: rng.between(bounds.minY, bounds.maxY),
    };
    if (pointInPolygon(point, polygon)) {
      sites.push({
        ...point,
        siteType: "interior",
      });
    }
  }

  while (sites.length < count) {
    const centroid = computePolygonCentroid(polygon);
    sites.push({
      ...centroid,
      siteType: "interior",
    });
  }

  return sites;
}

function relaxInteriorSitesOnce(sites, polygon) {
  const cells = buildClippedVoronoiCells(sites, polygon);
  const cellsBySiteIndex = new Map();
  cells.forEach((cell) => {
    const siteCells = cellsBySiteIndex.get(cell.siteIndex) || [];
    siteCells.push(cell);
    cellsBySiteIndex.set(cell.siteIndex, siteCells);
  });

  return sites.map((site, index) => {
    if (site.siteType === "boundary") {
      return {
        ...site,
      };
    }

    const siteCells = cellsBySiteIndex.get(index);
    if (!siteCells?.length) {
      return {
        ...site,
      };
    }

    const centroid = computeWeightedCellsCentroid(siteCells);
    return {
      ...centroid,
      siteType: site.siteType,
    };
  });
}

function computeWeightedCellsCentroid(cells) {
  let totalArea = 0;
  let x = 0;
  let y = 0;

  cells.forEach((cell) => {
    const area = Math.abs(computeSignedArea(cell.polygon));
    const centroid = computePolygonCentroid(cell.polygon);
    totalArea += area;
    x += centroid.x * area;
    y += centroid.y * area;
  });

  if (totalArea <= EPSILON) {
    return computePolygonCentroid(cells[0].polygon);
  }

  return {
    x: x / totalArea,
    y: y / totalArea,
  };
}

function buildClippedVoronoiCells(sites, polygon) {
  if (sites.length < 3) {
    return [];
  }

  const bounds = expandBounds(computeBounds(polygon), VORONOI_BOUNDS_PADDING);
  const clipTriangles = triangulatePolygon(polygon);
  const coordinates = sites.map((site) => [site.x, site.y]);
  const delaunay = Delaunay.from(coordinates);
  const voronoi = delaunay.voronoi([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]);

  return sites.flatMap((site, index) => {
    const cellPolygon = sanitizeVoronoiPolygon(voronoi.cellPolygon(index));
    return clipTriangles
      .map((triangle) => clipPolygonToPolygon(cellPolygon, triangle))
      .filter((clipped) => clipped.length >= 3 && Math.abs(computeSignedArea(clipped)) >= MIN_SUBLOT_AREA)
      .map((clipped) => ({
        siteIndex: index,
        site,
        siteType: site.siteType,
        polygon: clipped,
      }));
  });
}

function sanitizeVoronoiPolygon(points) {
  if (!points) {
    return [];
  }

  return normalizePolygon(points.slice(0, -1).map(([x, y]) => ({ x, y })));
}

function clipPolygonToPolygon(subjectPolygon, clipPolygon) {
  let output = normalizePolygon(subjectPolygon);

  for (let index = 0; index < clipPolygon.length; index += 1) {
    const clipStart = clipPolygon[index];
    const clipEnd = clipPolygon[(index + 1) % clipPolygon.length];
    const input = output;
    output = [];

    if (!input.length) {
      break;
    }

    let previous = input[input.length - 1];
    let previousInside = isInsideClipEdge(previous, clipStart, clipEnd);

    input.forEach((current) => {
      const currentInside = isInsideClipEdge(current, clipStart, clipEnd);
      if (currentInside) {
        if (!previousInside) {
          output.push(lineIntersection(previous, current, clipStart, clipEnd));
        }
        output.push(clonePoint(current));
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }

      previous = current;
      previousInside = currentInside;
    });

    output = normalizePolygon(output);
  }

  return output;
}

function triangulatePolygon(polygon) {
  if (polygon.length === 3) {
    return [polygon];
  }

  const remaining = polygon.map((point, index) => ({
    point,
    index,
  }));
  const triangles = [];
  let guard = polygon.length * polygon.length;

  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    const earIndex = remaining.findIndex((entry, index) => isEar(remaining, index));
    if (earIndex === -1) {
      break;
    }

    const previous = remaining[(earIndex - 1 + remaining.length) % remaining.length].point;
    const current = remaining[earIndex].point;
    const next = remaining[(earIndex + 1) % remaining.length].point;
    triangles.push(normalizePolygon([previous, current, next]));
    remaining.splice(earIndex, 1);
  }

  if (remaining.length === 3) {
    triangles.push(normalizePolygon(remaining.map((entry) => entry.point)));
  }

  return triangles.length ? triangles : fanTriangulate(polygon);
}

function fanTriangulate(polygon) {
  const triangles = [];
  for (let index = 1; index < polygon.length - 1; index += 1) {
    triangles.push(normalizePolygon([polygon[0], polygon[index], polygon[index + 1]]));
  }
  return triangles;
}

function isEar(vertices, index) {
  const previous = vertices[(index - 1 + vertices.length) % vertices.length].point;
  const current = vertices[index].point;
  const next = vertices[(index + 1) % vertices.length].point;
  const triangle = normalizePolygon([previous, current, next]);

  if (computeSignedArea(triangle) <= EPSILON) {
    return false;
  }

  return !vertices.some((entry, entryIndex) => {
    if (
      entryIndex === index
      || entryIndex === (index - 1 + vertices.length) % vertices.length
      || entryIndex === (index + 1) % vertices.length
    ) {
      return false;
    }
    return pointInTriangle(entry.point, triangle);
  });
}

function pointInTriangle(point, triangle) {
  const [first, second, third] = triangle;
  const sideA = pointSide(first, second, point);
  const sideB = pointSide(second, third, point);
  const sideC = pointSide(third, first, point);
  const hasNegative = sideA < -EPSILON || sideB < -EPSILON || sideC < -EPSILON;
  const hasPositive = sideA > EPSILON || sideB > EPSILON || sideC > EPSILON;
  return !(hasNegative && hasPositive);
}

function isInsideClipEdge(point, from, to) {
  return pointSide(from, to, point) >= -EPSILON;
}

function lineIntersection(firstFrom, firstTo, secondFrom, secondTo) {
  const firstVector = {
    x: firstTo.x - firstFrom.x,
    y: firstTo.y - firstFrom.y,
  };
  const secondVector = {
    x: secondTo.x - secondFrom.x,
    y: secondTo.y - secondFrom.y,
  };
  const denominator = cross(firstVector, secondVector);

  if (Math.abs(denominator) <= EPSILON) {
    return midpointBetween(firstTo, secondFrom);
  }

  const offset = {
    x: secondFrom.x - firstFrom.x,
    y: secondFrom.y - firstFrom.y,
  };
  const t = cross(offset, secondVector) / denominator;
  return {
    x: firstFrom.x + firstVector.x * t,
    y: firstFrom.y + firstVector.y * t,
  };
}

function normalizePolygon(points) {
  const normalized = [];
  points.forEach((point) => {
    const cloned = clonePoint(point);
    const previous = normalized[normalized.length - 1];
    if (!previous || pointDistance(previous, cloned) > EPSILON) {
      normalized.push(cloned);
    }
  });

  if (normalized.length > 1 && pointDistance(normalized[0], normalized[normalized.length - 1]) <= EPSILON) {
    normalized.pop();
  }

  if (computeSignedArea(normalized) < 0) {
    normalized.reverse();
  }

  return normalized;
}

function computeBounds(polygon) {
  return polygon.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

function expandBounds(bounds, padding) {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

function computePolygonCentroid(polygon) {
  if (!polygon.length) {
    return { x: 0, y: 0 };
  }

  let areaTwice = 0;
  let centroidX = 0;
  let centroidY = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const factor = current.x * next.y - next.x * current.y;
    areaTwice += factor;
    centroidX += (current.x + next.x) * factor;
    centroidY += (current.y + next.y) * factor;
  }

  if (Math.abs(areaTwice) < EPSILON) {
    return {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
  }

  return {
    x: centroidX / (3 * areaTwice),
    y: centroidY / (3 * areaTwice),
  };
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

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const intersects = ((current.y > point.y) !== (previous.y > point.y))
      && (point.x < ((previous.x - current.x) * (point.y - current.y)) / ((previous.y - current.y) || EPSILON) + current.x);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointSide(from, to, point) {
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

function cross(first, second) {
  return first.x * second.y - first.y * second.x;
}

function getOrCreateVertex(vertices, vertexByKey, point) {
  const key = pointKey(point);
  const existing = vertexByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const id = vertices.length;
  vertices.push({
    id,
    x: point.x,
    y: point.y,
  });
  vertexByKey.set(key, id);
  return id;
}

function pointKey(point) {
  return `${point.x.toFixed(POINT_KEY_DIGITS)},${point.y.toFixed(POINT_KEY_DIGITS)}`;
}
