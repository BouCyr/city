/*
 * WHAT: Keep the generator form synchronized with derived values and normalized defaults.
 * HOW: Wire range outputs and read the form into plain options.
 * WHY: The rest of the app should consume clean generation inputs without knowing about DOM quirks.
 */

const RANGE_FIELDS = [
  "pointCount",
  "scatterPaddingRatio",
  "poissonSpacingRatio",
  "poissonMaxAttempts",
  "poissonPaddingRatio",
  "waterReachRatio",
  "waterExpansionBase",
  "waterExpansionEdgeWeight",
  "waterPressureRangeRatio",
  "waterCenterBiasRadiusRatio",
  "relaxPaddingRatio",
  "primaryRiverTurnAngleDegrees",
  "tributaryRiverTurnAngleDegrees",
];
const WATER_SIDE_NAMES = ["north", "east", "south", "west"];
const DEFAULT_SEED = "city-seed";
const DEFAULT_POINT_COUNT = 500;
const MIN_POINT_COUNT = 50;
const MAX_POINT_COUNT = 1200;
const DEFAULT_SCATTER_PADDING_RATIO = 0.01;
const DEFAULT_SCATTER_ALGORITHM = "random_scattering";
const DEFAULT_TESSELLATE_ALGORITHM = "curved_bisection";
const DEFAULT_POISSON_SPACING_RATIO = 1.15;
const DEFAULT_POISSON_MAX_ATTEMPTS = 30;
const DEFAULT_POISSON_PADDING_RATIO = 0.01;
const DEFAULT_WATER_REACH_RATIO = 0.2;
const DEFAULT_WATER_EXPANSION_BASE = 0.14;
const DEFAULT_WATER_EXPANSION_EDGE_WEIGHT = 0.52;
const DEFAULT_WATER_PRESSURE_RANGE_RATIO = 0.42;
const DEFAULT_WATER_CENTER_BIAS_RADIUS_RATIO = 0.68;
const DEFAULT_RELAX_PADDING_RATIO = 0.04;
const DEFAULT_PRIMARY_RIVER_TURN_ANGLE_DEGREES = 30;
const DEFAULT_TRIBUTARY_RIVER_TURN_ANGLE_DEGREES = 30;
const DEFAULT_PRIMARY_RIVER_WIDTH = 18;
const DEFAULT_TRIBUTARY_WIDTH_RATIO = 0.72;
const DEFAULT_PRIMARY_MERGE_WIDTH_GAIN = 3.6;

/**
 * WHAT: Attach the live form behaviors that keep visible values in sync.
 * HOW: Mirror each range input into its paired output.
 * WHY: Users should see immediately which values are active.
 */
export function bindFormInteractions(form) {
  for (const name of RANGE_FIELDS) {
    const field = form.elements.namedItem(name);
    const output = document.querySelector(`#${name}Value`);
    if (!(field instanceof HTMLInputElement) || !(output instanceof HTMLOutputElement)) {
      continue;
    }

    const sync = () => {
      const suffix = name.endsWith("RiverTurnAngleDegrees") ? "°" : "";
      output.value = `${field.value}${suffix}`;
      output.textContent = `${field.value}${suffix}`;
    };

    field.addEventListener("input", sync);
    sync();
  }

  const pointCountField = form.elements.namedItem("pointCount");
  const pointCountOutput = document.querySelector("#pointCountValue");
  const scatterAlgorithmFields = Array.from(form.querySelectorAll('input[name="scatterAlgorithm"]'));
  if (!(pointCountField instanceof HTMLInputElement) || !(pointCountOutput instanceof HTMLOutputElement) || !scatterAlgorithmFields.length) {
    return;
  }

  const syncSquareGridPointCount = () => {
    const scatterAlgorithm = getSelectedScatterAlgorithm(form);
    const normalizedValue = normalizePointCountForScatterAlgorithm(
      Number(pointCountField.value),
      scatterAlgorithm,
      Number(pointCountField.min) || MIN_POINT_COUNT,
      Number(pointCountField.max) || MAX_POINT_COUNT,
    );

    if (String(normalizedValue) !== pointCountField.value) {
      pointCountField.value = String(normalizedValue);
    }
    pointCountOutput.value = pointCountField.value;
    pointCountOutput.textContent = pointCountField.value;
  };

  pointCountField.addEventListener("input", syncSquareGridPointCount);
  scatterAlgorithmFields.forEach((field) => {
    field.addEventListener("change", syncSquareGridPointCount);
  });
  syncSquareGridPointCount();
}

/**
 * WHAT: Convert the current form DOM state into the normalized options object used by generation.
 * HOW: Read the raw form values, rebuild the water-side list, and normalize counts.
 * WHY: The generator should not need to interpret strings, unchecked boxes, or invalid slider values.
 */
export function readFormState(form) {
  const data = new FormData(form);
  const scatterAlgorithm = normalizeScatterAlgorithm(String(data.get("scatterAlgorithm") || DEFAULT_SCATTER_ALGORITHM));
  const selectedWaterSides = data.getAll("waterSides");
  const waterSides = WATER_SIDE_NAMES.map((side) => ({
    name: side,
    enabled: selectedWaterSides.includes(side),
  }));
  return {
    seed: String(data.get("seed") || DEFAULT_SEED),
    stepAlgorithms: {
      scatterPoints: scatterAlgorithm,
      tessellateLots: normalizeTessellateAlgorithm(String(data.get("tessellateAlgorithm") || DEFAULT_TESSELLATE_ALGORITHM)),
    },
    pointCount: normalizePointCountForScatterAlgorithm(Number(data.get("pointCount") || DEFAULT_POINT_COUNT), scatterAlgorithm, MIN_POINT_COUNT, MAX_POINT_COUNT),
    scatterPaddingRatio: normalizeDecimal(Number(data.get("scatterPaddingRatio") || DEFAULT_SCATTER_PADDING_RATIO), 0, 0.1),
    poissonSpacingRatio: normalizeDecimal(Number(data.get("poissonSpacingRatio") || DEFAULT_POISSON_SPACING_RATIO), 0.4, 2.4),
    poissonMaxAttempts: normalizeInteger(Number(data.get("poissonMaxAttempts") || DEFAULT_POISSON_MAX_ATTEMPTS), 4, 80),
    poissonPaddingRatio: normalizeDecimal(Number(data.get("poissonPaddingRatio") || DEFAULT_POISSON_PADDING_RATIO), 0, 0.15),
    primaryRiverWidth: normalizeDecimal(Number(data.get("primaryRiverWidth") || DEFAULT_PRIMARY_RIVER_WIDTH), 6, 36),
    waterReachRatio: normalizeDecimal(Number(data.get("waterReachRatio") || DEFAULT_WATER_REACH_RATIO), 0, 0.5),
    waterExpansionBase: normalizeDecimal(Number(data.get("waterExpansionBase") || DEFAULT_WATER_EXPANSION_BASE), 0, 1),
    waterExpansionEdgeWeight: normalizeDecimal(Number(data.get("waterExpansionEdgeWeight") || DEFAULT_WATER_EXPANSION_EDGE_WEIGHT), 0, 1),
    waterPressureRangeRatio: normalizeDecimal(Number(data.get("waterPressureRangeRatio") || DEFAULT_WATER_PRESSURE_RANGE_RATIO), 0.1, 1),
    waterCenterBiasRadiusRatio: normalizeDecimal(Number(data.get("waterCenterBiasRadiusRatio") || DEFAULT_WATER_CENTER_BIAS_RADIUS_RATIO), 0, 1),
    relaxPaddingRatio: normalizeDecimal(Number(data.get("relaxPaddingRatio") || DEFAULT_RELAX_PADDING_RATIO), 0, 0.15),
    primaryRiverTurnAngleDegrees: normalizeDecimal(Number(data.get("primaryRiverTurnAngleDegrees") || DEFAULT_PRIMARY_RIVER_TURN_ANGLE_DEGREES), 30, 180),
    tributaryRiverTurnAngleDegrees: normalizeDecimal(Number(data.get("tributaryRiverTurnAngleDegrees") || DEFAULT_TRIBUTARY_RIVER_TURN_ANGLE_DEGREES), 30, 180),
    tributaryWidthRatio: normalizeDecimal(Number(data.get("tributaryWidthRatio") || DEFAULT_TRIBUTARY_WIDTH_RATIO), 0.3, 1),
    primaryMergeWidthGain: normalizeDecimal(Number(data.get("primaryMergeWidthGain") || DEFAULT_PRIMARY_MERGE_WIDTH_GAIN), 0, 12),
    waterSides,
  };
}

function normalizeScatterAlgorithm(value) {
  if (value === "poisson_disk" || value === "square_grid") {
    return value;
  }
  return "random_scattering";
}

function normalizeTessellateAlgorithm(value) {
  if (value === "poisson_voronoi" || value === "curved_bisection" || value === "straight_bisection") {
    return value;
  }
  return DEFAULT_TESSELLATE_ALGORITHM;
}

function getSelectedScatterAlgorithm(form) {
  const selected = form.querySelector('input[name="scatterAlgorithm"]:checked');
  return normalizeScatterAlgorithm(selected instanceof HTMLInputElement ? selected.value : DEFAULT_SCATTER_ALGORITHM);
}

function normalizePointCountForScatterAlgorithm(value, scatterAlgorithm, min, max) {
  const normalized = normalizeInteger(value, min, max);
  if (scatterAlgorithm !== "square_grid") {
    return normalized;
  }

  return findNearestPerfectSquare(normalized, min, max);
}

function findNearestPerfectSquare(value, min, max) {
  const minRoot = Math.ceil(Math.sqrt(min));
  const maxRoot = Math.floor(Math.sqrt(max));
  const lowerRoot = clamp(Math.floor(Math.sqrt(value)), minRoot, maxRoot);
  const upperRoot = clamp(Math.ceil(Math.sqrt(value)), minRoot, maxRoot);
  const lowerSquare = lowerRoot * lowerRoot;
  const upperSquare = upperRoot * upperRoot;

  if (Math.abs(value - lowerSquare) <= Math.abs(upperSquare - value)) {
    return lowerSquare;
  }
  return upperSquare;
}

function normalizeNonNegativeCount(value) {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function normalizeBoundedCount(value, min, max) {
  const normalized = Math.floor(Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, normalized));
}

function normalizeInteger(value, min, max) {
  return normalizeBoundedCount(value, min, max);
}

function normalizeDecimal(value, min, max) {
  const normalized = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, normalized));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
