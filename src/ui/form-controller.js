/*
 * WHAT: Keep the generator form synchronized with derived values and normalized defaults.
 * HOW: Wire range outputs and read the form into plain options.
 * WHY: The rest of the app should consume clean generation inputs without knowing about DOM quirks.
 */

const RANGE_FIELDS = ["pointCount", "hillCount"];
const WATER_SIDE_NAMES = ["north", "east", "south", "west"];
const DEFAULT_SEED = "city-seed";
const DEFAULT_POINT_COUNT = 1000;
const DEFAULT_HILL_COUNT = 15;

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
    pointCount: Number(data.get("pointCount") || DEFAULT_POINT_COUNT),
    hillCount: normalizeNonNegativeCount(Number(data.get("hillCount") || DEFAULT_HILL_COUNT)),
    waterSides,
  };
}

function normalizeNonNegativeCount(value) {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}
