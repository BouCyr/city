/*
 * WHAT: Scatter the initial pseudo-random sites used to seed the Voronoi map.
 * HOW: Sample the seeded RNG inside a small padded box and replace any previous geometry.
 * WHY: Point generation is the deterministic source for every later step.
 */

export function runScatterPointsStep(map, { rng }) {
  const padding = map.meta.size * (map.init.params.scatterPaddingRatio ?? 0.01);
  const pointCount = map.init.params.pointCount;
  const points = Array.from({ length: pointCount }, (_, index) => ({
    id: index,
    x: rng.between(padding, map.meta.size - padding),
    y: rng.between(padding, map.meta.size - padding),
  }));

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
