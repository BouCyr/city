import { Delaunay } from "https://cdn.jsdelivr.net/npm/d3-delaunay@6/+esm";

export function buildVoronoiDiagram({ points, width, height }) {
  const coordinates = points.map((point) => [point.x, point.y]);
  const delaunay = Delaunay.from(coordinates);
  const voronoi = delaunay.voronoi([0, 0, width, height]);

  const cells = points.map((point, index) => {
    const polygon = sanitizePolygon(voronoi.cellPolygon(index));
    const neighbors = Array.from(delaunay.neighbors(index));
    const centroid = polygon.length > 0 ? computeCentroid(polygon) : { x: point.x, y: point.y };
    return {
      id: index,
      site: point,
      polygon,
      centroid,
      neighbors,
      touches: detectTouches(polygon, width, height),
      isSea: false,
    };
  });

  const edges = [];
  for (let index = 0; index < points.length; index += 1) {
    for (const neighborId of cells[index].neighbors) {
      if (neighborId <= index) {
        continue;
      }

      const edge = extractSharedEdge(cells[index].polygon, cells[neighborId].polygon);
      if (edge) {
        edges.push({
          id: `${index}-${neighborId}`,
          a: index,
          b: neighborId,
          from: edge[0],
          to: edge[1],
          kind: "land",
        });
      }
    }
  }

  return { cells, edges };
}

function sanitizePolygon(polygon) {
  if (!polygon) {
    return [];
  }

  const cleaned = polygon.slice(0, -1).map(([x, y]) => ({ x, y }));
  return dedupePoints(cleaned);
}

function dedupePoints(points) {
  const result = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || distanceSquared(previous, point) > 0.01) {
      result.push(point);
    }
  }
  return result;
}

function computeCentroid(polygon) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }

  if (Math.abs(twiceArea) < 0.0001) {
    return polygon[0] || { x: 0, y: 0 };
  }

  return {
    x: x / (3 * twiceArea),
    y: y / (3 * twiceArea),
  };
}

function detectTouches(polygon, width, height) {
  const threshold = 0.5;
  return {
    north: polygon.some((point) => point.y <= threshold),
    south: polygon.some((point) => point.y >= height - threshold),
    west: polygon.some((point) => point.x <= threshold),
    east: polygon.some((point) => point.x >= width - threshold),
  };
}

function extractSharedEdge(firstPolygon, secondPolygon) {
  const shared = [];
  for (const pointA of firstPolygon) {
    for (const pointB of secondPolygon) {
      if (distanceSquared(pointA, pointB) < 0.25) {
        shared.push(pointA);
      }
    }
  }

  const unique = dedupePoints(shared);
  if (unique.length < 2) {
    return null;
  }

  return [unique[0], unique[1]];
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
