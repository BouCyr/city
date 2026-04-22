import { createSeededRandom } from "./random.js";

export async function generateCity(options, stepTracker) {
  stepTracker.reset();
  const rng = await stepTracker.advance(0, "Seeding", async () => createSeededRandom(options.seed));
  const water = await stepTracker.advance(1, "Terrain", async () => createWater(rng, options));
  const districts = await stepTracker.advance(2, "Districts", async () => createDistricts(rng, options, water));
  const roads = await stepTracker.advance(3, "Roads", async () => createRoads(rng, options, water));
  const blocks = await stepTracker.advance(4, "Blocks", async () => createBlocks(rng, districts, roads, options));
  const landmarks = await stepTracker.advance(5, "Landmarks", async () =>
    createLandmarks(rng, options, districts, water),
  );
  const summary = await stepTracker.advance(6, "Compositing", async () => createSummary(options, water, districts));
  stepTracker.complete();

  return {
    ...summary,
    seed: options.seed,
    size: options.mapSize,
    water,
    districts,
    roads,
    blocks,
    landmarks,
  };
}

function createWater(rng, options) {
  const type = options.waterMode === "random" ? rng.pick(["none", "river", "coast"]) : options.waterMode;
  if (type === "none") {
    return { type };
  }

  if (type === "coast") {
    const side = rng.pick(["north", "south", "east", "west"]);
    const depth = rng.between(0.18, 0.34);
    return { type, side, depth };
  }

  return {
    type,
    bends: Array.from({ length: 5 }, (_, index) => ({
      x: rng.between(0.12, 0.88),
      y: index / 4,
      width: rng.between(0.04, 0.08),
    })),
  };
}

function createDistricts(rng, options, water) {
  const margin = 0.12;
  return Array.from({ length: options.districts }, (_, index) => ({
    id: `D${index + 1}`,
    x: clampWaterAvoidance(rng.between(margin, 1 - margin), water),
    y: rng.between(margin, 1 - margin),
    radius: rng.between(0.09, 0.18),
    tone: rng.pick(["civic", "market", "garden", "industrial", "residential"]),
  }));
}

function createRoads(rng, options, water) {
  const roads = [];
  const count = options.roadDensity * 3 + 4;
  const style = options.streetStyle;

  for (let index = 0; index < count; index += 1) {
    const bias = index / Math.max(count - 1, 1);
    if (style === "grid" || (style === "mixed" && index % 2 === 0)) {
      const vertical = index % 3 !== 0;
      roads.push(
        vertical
          ? lineRoad(clampWaterAvoidance(0.1 + bias * 0.8, water), 0.06, clampWaterAvoidance(0.1 + bias * 0.8, water), 0.94)
          : lineRoad(0.06, 0.1 + bias * 0.8, 0.94, 0.1 + bias * 0.8),
      );
    } else {
      roads.push(radialRoad(rng, bias));
    }
  }

  return roads;
}

function createBlocks(rng, districts, roads, options) {
  const count = districts.length * 4 + options.roadDensity * 3;
  return Array.from({ length: count }, (_, index) => {
    const district = districts[index % districts.length];
    return {
      x: district.x + rng.between(-0.08, 0.08),
      y: district.y + rng.between(-0.08, 0.08),
      w: rng.between(0.015, 0.045),
      h: rng.between(0.015, 0.045),
      rotation: rng.between(-0.6, 0.6) + roads[index % roads.length].weight * 0.1,
    };
  });
}

function createLandmarks(rng, options, districts, water) {
  return Array.from({ length: options.landmarks }, (_, index) => {
    const district = districts[index % districts.length];
    return {
      name: rng.pick(["Station", "Hall", "Tower", "Museum", "Forum", "Garden"]),
      x: clampWaterAvoidance(district.x + rng.between(-0.05, 0.05), water),
      y: district.y + rng.between(-0.05, 0.05),
      size: rng.between(0.018, 0.032),
    };
  });
}

function createSummary(options, water, districts) {
  return {
    profile: `${options.streetStyle} streets, ${water.type} terrain`,
    centroid: districts.reduce(
      (acc, district) => ({ x: acc.x + district.x / districts.length, y: acc.y + district.y / districts.length }),
      { x: 0, y: 0 },
    ),
  };
}

function radialRoad(rng, bias) {
  const angle = bias * Math.PI * 1.7 + rng.between(-0.2, 0.2);
  const length = rng.between(0.32, 0.49);
  const centerX = 0.5;
  const centerY = 0.5;
  return {
    x1: centerX,
    y1: centerY,
    x2: centerX + Math.cos(angle) * length,
    y2: centerY + Math.sin(angle) * length,
    weight: rng.between(0.8, 1.4),
  };
}

function lineRoad(x1, y1, x2, y2) {
  return { x1, y1, x2, y2, weight: 1 };
}

function clampWaterAvoidance(value, water) {
  if (water.type === "coast" && water.side === "west") {
    return Math.max(value, water.depth + 0.05);
  }
  if (water.type === "coast" && water.side === "east") {
    return Math.min(value, 0.95 - water.depth);
  }
  return value;
}
