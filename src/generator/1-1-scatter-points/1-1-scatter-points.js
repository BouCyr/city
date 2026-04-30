/*
 * WHAT: Scatter the initial sites used to seed the Voronoi map.
 * HOW: Use the selected step 1.1 algorithm from map params (random scatter or Poisson disk).
 * WHY: Point generation is the deterministic source for every later step.
 */

const TAU = Math.PI * 2;

export function runScatterPointsStep(map, { rng }) {
  const algorithm = map.init.params.stepAlgorithms?.scatterPoints || "random_scattering";
  const pointCount = map.init.params.pointCount;
  let points;
  if (algorithm === "poisson_disk") {
    points = generatePoissonPoints(map, rng, pointCount);
  } else if (algorithm === "square_grid") {
    points = generateSquareGridPoints(map, pointCount);
  } else {
    points = generateRandomPoints(map, rng, pointCount);
  }

  const nextMap = {
    ...map,
    points,
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

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.1 / Scattered points",
        map: nextMap,
      },
    ],
  };
}

function generateRandomPoints(map, rng, pointCount) {
  const padding = map.meta.size * (map.init.params.scatterPaddingRatio ?? 0.01);
  return Array.from({ length: pointCount }, (_, index) => ({
    id: index,
    x: rng.between(padding, map.meta.size - padding),
    y: rng.between(padding, map.meta.size - padding),
  }));
}

function generatePoissonPoints(map, rng, pointCount) {
  const size = map.meta.size;
  const paddingRatio = map.init.params.poissonPaddingRatio ?? map.init.params.scatterPaddingRatio ?? 0.01;
  const spacingRatio = map.init.params.poissonSpacingRatio ?? 1.15;
  const area = size * size;
  const nominalSpacing = Math.sqrt(area / Math.max(1, pointCount));
  const densitySpacing = nominalSpacing * 0.72;
  const minDistance = Math.max(size * 0.0025, densitySpacing * spacingRatio);
  const maxAttempts = Math.max(
    map.init.params.poissonMaxAttempts ?? 30,
    Math.round(Math.sqrt(size) * 2),
  );
  const minX = size * paddingRatio;
  const minY = size * paddingRatio;
  const maxX = size - minX;
  const maxY = size - minY;

  if (maxX <= minX || maxY <= minY) {
    return generateRandomPoints(map, rng, pointCount);
  }

  const poissonPoints = samplePoissonDisk({
    pointCount,
    minDistance,
    maxAttempts,
    minX,
    minY,
    maxX,
    maxY,
    rng,
  });

  // Ensure downstream steps always receive pointCount points.
  while (poissonPoints.length < pointCount) {
    poissonPoints.push({
      x: rng.between(minX, maxX),
      y: rng.between(minY, maxY),
    });
  }

  return poissonPoints.slice(0, pointCount).map((point, index) => ({
    id: index,
    x: point.x,
    y: point.y,
  }));
}

function generateSquareGridPoints(map, pointCount) {
  const size = map.meta.size;
  const padding = size * (map.init.params.scatterPaddingRatio ?? 0.01);
  const minX = padding;
  const minY = padding;
  const maxX = size - padding;
  const maxY = size - padding;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  const cols = Math.max(1, Math.ceil(Math.sqrt((pointCount * width) / height)));
  const rows = Math.max(1, Math.ceil(pointCount / cols));
  const stepX = width / cols;
  const stepY = height / rows;
  const points = [];

  for (let row = 0; row < rows && points.length < pointCount; row += 1) {
    for (let col = 0; col < cols && points.length < pointCount; col += 1) {
      points.push({
        id: points.length,
        x: minX + (col + 0.5) * stepX,
        y: minY + (row + 0.5) * stepY,
      });
    }
  }

  return points;
}

function samplePoissonDisk({ pointCount, minDistance, maxAttempts, minX, minY, maxX, maxY, rng }) {
  const cellSize = minDistance / Math.sqrt(2);
  const width = maxX - minX;
  const height = maxY - minY;
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const grid = Array.from({ length: cols * rows }, () => []);
  const points = [];
  const active = [];

  const first = {
    x: rng.between(minX, maxX),
    y: rng.between(minY, maxY),
  };
  addPoint(first);

  while (active.length && points.length < pointCount) {
    const activeIndex = Math.floor(rng.next() * active.length);
    const basePoint = points[active[activeIndex]];
    let placed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const angle = rng.between(0, TAU);
      const distance = minDistance * (1 + rng.next());
      const candidate = {
        x: basePoint.x + Math.cos(angle) * distance,
        y: basePoint.y + Math.sin(angle) * distance,
      };

      if (!insideBounds(candidate)) {
        continue;
      }
      if (!isFarEnough(candidate)) {
        continue;
      }

      addPoint(candidate);
      placed = true;
      break;
    }

    if (!placed) {
      active.splice(activeIndex, 1);
    }
  }

  if (points.length >= pointCount) {
    return points;
  }

  return points;

  function addPoint(point) {
    const pointIndex = points.length;
    points.push(point);
    active.push(pointIndex);
    grid[cellIndex(point)].push(pointIndex);
  }

  function insideBounds(point) {
    return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  }

  function cellCoordinates(point) {
    const x = Math.max(0, Math.min(cols - 1, Math.floor((point.x - minX) / cellSize)));
    const y = Math.max(0, Math.min(rows - 1, Math.floor((point.y - minY) / cellSize)));
    return { x, y };
  }

  function cellIndex(point) {
    const cell = cellCoordinates(point);
    return cell.y * cols + cell.x;
  }

  function isFarEnough(point) {
    const cell = cellCoordinates(point);
    for (let y = Math.max(0, cell.y - 2); y <= Math.min(rows - 1, cell.y + 2); y += 1) {
      for (let x = Math.max(0, cell.x - 2); x <= Math.min(cols - 1, cell.x + 2); x += 1) {
        const neighborIndices = grid[y * cols + x];
        if (!neighborIndices.length) {
          continue;
        }

        for (let index = 0; index < neighborIndices.length; index += 1) {
          const neighbor = points[neighborIndices[index]];
          const dx = neighbor.x - point.x;
          const dy = neighbor.y - point.y;
          if ((dx * dx) + (dy * dy) < minDistance * minDistance) {
            return false;
          }
        }
      }
    }
    return true;
  }
}
