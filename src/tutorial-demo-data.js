/*
 * WHAT: Provide deterministic generated maps for tutorial pages.
 * HOW: Run the real generation pipeline with small fixed settings and cache the resulting step maps.
 * WHY: The demos should illustrate the production steps, not separate hand-built fixtures.
 */

import { generateCityThroughStep } from "./generator/city-generator.js";

const DEFAULTS = {
  scatterPaddingRatio: 0.01,
  poissonSpacingRatio: 1.15,
  poissonMaxAttempts: 30,
  poissonPaddingRatio: 0.01,
  waterReachRatio: 0.2,
  waterExpansionBase: 0.14,
  waterExpansionEdgeWeight: 0.52,
  waterPressureRangeRatio: 0.42,
  waterCenterBiasRadiusRatio: 0.68,
  relaxPaddingRatio: 0.04,
  primaryRiverWidth: 18,
  primaryRiverTurnAngleDegrees: 30,
  tributaryRiverTurnAngleDegrees: 30,
  tributaryWidthRatio: 0.72,
  primaryMergeWidthGain: 3.6,
  parishCount: 3,
  routeCrossingCost: 1500,
  stepAlgorithms: {
    scatterPoints: "random_scattering",
    parishClustering: "graph_kmeans",
    tessellateLots: "curved_bisection",
  },
};

const cache = new Map();

export async function getCoastlineDemoDataset() {
  const map = await getCachedMap("coastline-demo", {
    ...DEFAULTS,
    seed: "coastline-demo",
    pointCount: 30,
    mapSize: 700,
    waterSides: waterSides({ north: true }),
  }, 6);
  return {
    id: "generatedCoastline",
    name: "Generated coastline",
    map,
    cells: map.cells,
    edges: map.edges,
  };
}

export async function getRiverDemoDataset() {
  const map = await getCachedMap("river-demo", {
    ...DEFAULTS,
    seed: "river-demo",
    pointCount: 40,
    mapSize: 720,
    waterSides: waterSides({ north: true }),
  }, 7);
  return {
    id: "generatedRiver",
    name: "Generated river",
    size: map.meta?.size || 720,
    map,
  };
}

export async function getParishSmoothingDemoDataset() {
  const map = await getCachedMap("parish-demo", {
    ...DEFAULTS,
    seed: "parish-demo",
    pointCount: 15,
    mapSize: 720,
    waterSides: waterSides({}),
  }, 10);
  return {
    id: "generatedParishes",
    name: "Generated parishes",
    size: map.meta?.size || 720,
    map,
  };
}

export async function getBisectionDemoDataset() {
  const map = await getCachedMap("bisection-demo", {
    ...DEFAULTS,
    seed: "bisection-demo",
    pointCount: 90,
    mapSize: 900,
    waterSides: waterSides({ north: true }),
  }, 11);
  const lots = (map.lots || [])
    .filter((lot) => lot.features?.land && !lot.features?.sea && !lot.features?.boundary && Array.isArray(lot.polygon) && lot.polygon.length >= 4)
    .map((lot) => ({
      id: lot.id,
      polygon: lot.polygon,
      name: `Lot ${lot.id}`,
      area: Math.abs(computeSignedArea(lot.polygon)),
      complexity: lot.polygon.length,
    }))
    .sort((first, second) => second.area - first.area || second.complexity - first.complexity)
    .slice(0, 4)
    .map(({ area, complexity, ...lot }) => lot);
  return {
    id: "generatedBisection",
    name: "Generated lots",
    size: map.meta?.size || 900,
    map,
    lots,
  };
}

async function getCachedMap(cacheKey, options, endStepIndex) {
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, generateCityThroughStep(options, endStepIndex));
  }
  return cache.get(cacheKey);
}

function waterSides(enabledByName) {
  return ["north", "east", "south", "west"].map((name) => ({
    name,
    enabled: Boolean(enabledByName[name]),
  }));
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
