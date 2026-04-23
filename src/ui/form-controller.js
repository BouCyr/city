/*
 * WHAT: Keep the generator form synchronized with derived values and normalized defaults.
 * HOW: Wire range outputs, clamp river settings against water-side choices, and read the form into plain options.
 * WHY: The rest of the app should consume clean generation inputs without knowing about DOM quirks.
 */

const RANGE_FIELDS = ["pointCount", "riverCount"];
const WATER_SIDE_NAMES = ["north", "east", "south", "west"];
const DEFAULT_SEED = "city-seed";
const DEFAULT_POINT_COUNT = 1000;
const DEFAULT_RIVER_COUNT = 0;
const MAX_RIVER_COUNT = 4;
const RIVER_TOUCHED_DATASET_KEY = "touched";
const RIVER_TOUCHED_VALUE = "true";

/**
 * WHAT: Attach the live form behaviors that keep visible values and derived river limits in sync.
 * HOW: Mirror each range input into its paired output, then recompute valid river counts whenever water sides change.
 * WHY: Users should see immediately which values are active and never be able to request impossible river setups.
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

  const riverField = form.elements.namedItem("riverCount");
  const waterSideFields = Array.from(form.elements.namedItem("waterSides"));
  if (!(riverField instanceof HTMLInputElement) || waterSideFields.some((field) => !(field instanceof HTMLInputElement))) {
    return;
  }

  let previousDefault = applyRiverConstraints(riverField, waterSideFields, true);
  riverField.dataset[RIVER_TOUCHED_DATASET_KEY] = "false";
  riverField.addEventListener("input", () => {
    riverField.dataset[RIVER_TOUCHED_DATASET_KEY] = RIVER_TOUCHED_VALUE;
  });

  waterSideFields.forEach((field) => {
    field.addEventListener("change", () => {
      previousDefault = applyRiverConstraints(
        riverField,
        waterSideFields,
        riverField.dataset[RIVER_TOUCHED_DATASET_KEY] !== RIVER_TOUCHED_VALUE,
        previousDefault,
      );
    });
  });
}

/**
 * WHAT: Convert the current form DOM state into the normalized options object used by generation.
 * HOW: Read the raw form values, rebuild the water-side list, and clamp river count to the valid range.
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
    pointCount: Number(data.get("pointCount") || DEFAULT_POINT_COUNT),
    riverCount: normalizeRiverCount(Number(data.get("riverCount") || DEFAULT_RIVER_COUNT), waterSides),
    waterSides,
  };
}

function applyRiverConstraints(riverField, waterSideFields, shouldUseDefault = false, previousDefault = null) {
  const waterSides = waterSideFields.map((field) => ({
    name: field.value,
    enabled: field.checked,
  }));
  const defaultValue = computeDefaultRiverCount(waterSides);
  const maxValue = computeMaxRiverCount(waterSides);
  riverField.max = String(maxValue);

  const currentValue = Number(riverField.value || 0);
  const shouldReset = shouldUseDefault || currentValue > maxValue || currentValue === previousDefault;
  const nextValue = shouldReset ? defaultValue : Math.min(currentValue, maxValue);
  riverField.value = String(nextValue);

  const output = document.querySelector("#riverCountValue");
  if (output instanceof HTMLOutputElement) {
    output.value = riverField.value;
    output.textContent = riverField.value;
  }

  riverField.disabled = maxValue === 0;
  return defaultValue;
}

function normalizeRiverCount(value, waterSides) {
  const maxValue = computeMaxRiverCount(waterSides);
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, maxValue));
}

function computeDefaultRiverCount(waterSides) {
  const landSideCount = waterSides.filter((side) => !side.enabled).length;
  return Math.max(0, Math.min(MAX_RIVER_COUNT, landSideCount - 1));
}

function computeMaxRiverCount(waterSides) {
  return waterSides.every((side) => side.enabled) ? 0 : MAX_RIVER_COUNT;
}
