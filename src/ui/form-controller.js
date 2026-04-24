/*
 * WHAT: Keep the generator form synchronized with derived values and normalized defaults.
 * HOW: Wire range outputs and read the form into plain options.
 * WHY: The rest of the app should consume clean generation inputs without knowing about DOM quirks.
 */

const RANGE_FIELDS = [
  "pointCount",
  "scatterPaddingRatio",
  "waterReachRatio",
  "waterExpansionBase",
  "waterExpansionEdgeWeight",
  "waterPressureRangeRatio",
  "waterCenterBiasRadiusRatio",
  "relaxPaddingRatio",
  "hillCount",
  "hillSeaDistance",
  "hillsideRadius",
  "riverTurnAngle",
  "primaryRiverWidth",
  "tributarySourceRiverDistance",
  "tributaryMergeSeaDistance",
  "tributaryWidthRatio",
  "primaryMergeWidthGain",
];
const WATER_SIDE_NAMES = ["north", "east", "south", "west"];
const DEFAULT_SEED = "city-seed";
const DEFAULT_POINT_COUNT = 1000;
const DEFAULT_SCATTER_PADDING_RATIO = 0.01;
const DEFAULT_WATER_REACH_RATIO = 0.2;
const DEFAULT_WATER_EXPANSION_BASE = 0.14;
const DEFAULT_WATER_EXPANSION_EDGE_WEIGHT = 0.52;
const DEFAULT_WATER_PRESSURE_RANGE_RATIO = 0.42;
const DEFAULT_WATER_CENTER_BIAS_RADIUS_RATIO = 0.68;
const DEFAULT_RELAX_PADDING_RATIO = 0.04;
const DEFAULT_HILL_COUNT = 15;
const DEFAULT_HILL_SEA_DISTANCE = 4;
const DEFAULT_HILLSIDE_RADIUS = 2;
const DEFAULT_RIVER_TURN_ANGLE = 90;
const DEFAULT_PRIMARY_RIVER_WIDTH = 6;
const DEFAULT_TRIBUTARY_SOURCE_RIVER_DISTANCE = 6;
const DEFAULT_TRIBUTARY_MERGE_SEA_DISTANCE = 5;
const DEFAULT_TRIBUTARY_WIDTH_RATIO = 0.72;
const DEFAULT_PRIMARY_MERGE_WIDTH_GAIN = 1.2;

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
      output.value = field.value;
      output.textContent = field.value;
    };

    field.addEventListener("input", sync);
    sync();
  }
}

/**
 * WHAT: Convert the current form DOM state into the normalized options object used by generation.
 * HOW: Read the raw form values, rebuild the water-side list, and normalize counts.
 * WHY: The generator should not need to interpret strings, unchecked boxes, or invalid slider values.
 */
export function readFormState(form) {
  const data = new FormData(form);
  const selectedWaterSides = data.getAll("waterSides");
  const waterSides = WATER_SIDE_NAMES.map((side) => ({
    name: side,
    enabled: selectedWaterSides.includes(side),
  }));
  return {
    seed: String(data.get("seed") || DEFAULT_SEED),
    pointCount: normalizeInteger(Number(data.get("pointCount") || DEFAULT_POINT_COUNT), 50, 1200),
    scatterPaddingRatio: normalizeDecimal(Number(data.get("scatterPaddingRatio") || DEFAULT_SCATTER_PADDING_RATIO), 0, 0.1),
    hillCount: normalizeNonNegativeCount(Number(data.get("hillCount") || DEFAULT_HILL_COUNT)),
    hillSeaDistance: normalizeInteger(Number(data.get("hillSeaDistance") || DEFAULT_HILL_SEA_DISTANCE), 0, 12),
    hillsideRadius: normalizeInteger(Number(data.get("hillsideRadius") || DEFAULT_HILLSIDE_RADIUS), 0, 6),
    riverTurnAngle: normalizeBoundedCount(Number(data.get("riverTurnAngle") || DEFAULT_RIVER_TURN_ANGLE), 0, 120),
    primaryRiverWidth: normalizeDecimal(Number(data.get("primaryRiverWidth") || DEFAULT_PRIMARY_RIVER_WIDTH), 2, 12),
    tributarySourceRiverDistance: normalizeInteger(Number(data.get("tributarySourceRiverDistance") || DEFAULT_TRIBUTARY_SOURCE_RIVER_DISTANCE), 0, 20),
    waterReachRatio: normalizeDecimal(Number(data.get("waterReachRatio") || DEFAULT_WATER_REACH_RATIO), 0, 0.5),
    waterExpansionBase: normalizeDecimal(Number(data.get("waterExpansionBase") || DEFAULT_WATER_EXPANSION_BASE), 0, 1),
    waterExpansionEdgeWeight: normalizeDecimal(Number(data.get("waterExpansionEdgeWeight") || DEFAULT_WATER_EXPANSION_EDGE_WEIGHT), 0, 1),
    waterPressureRangeRatio: normalizeDecimal(Number(data.get("waterPressureRangeRatio") || DEFAULT_WATER_PRESSURE_RANGE_RATIO), 0.1, 1),
    waterCenterBiasRadiusRatio: normalizeDecimal(Number(data.get("waterCenterBiasRadiusRatio") || DEFAULT_WATER_CENTER_BIAS_RADIUS_RATIO), 0, 1),
    relaxPaddingRatio: normalizeDecimal(Number(data.get("relaxPaddingRatio") || DEFAULT_RELAX_PADDING_RATIO), 0, 0.15),
    tributaryMergeSeaDistance: normalizeInteger(Number(data.get("tributaryMergeSeaDistance") || DEFAULT_TRIBUTARY_MERGE_SEA_DISTANCE), 0, 20),
    tributaryWidthRatio: normalizeDecimal(Number(data.get("tributaryWidthRatio") || DEFAULT_TRIBUTARY_WIDTH_RATIO), 0.3, 1),
    primaryMergeWidthGain: normalizeDecimal(Number(data.get("primaryMergeWidthGain") || DEFAULT_PRIMARY_MERGE_WIDTH_GAIN), 0, 4),
    waterSides,
  };
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
