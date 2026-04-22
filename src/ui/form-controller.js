const HELP_FALLBACK =
  "Hover or focus a field to inspect what it changes. The same seed and settings always produce the same map.";

const RANGE_FIELDS = ["districts", "roadDensity", "landmarks"];

export function bindFormInteractions(form, helpElement) {
  for (const field of form.elements) {
    if (!(field instanceof HTMLElement) || !field.name) {
      continue;
    }

    const updateHelp = () => {
      helpElement.textContent = field.dataset.help || HELP_FALLBACK;
    };

    field.addEventListener("mouseenter", updateHelp);
    field.addEventListener("focus", updateHelp);
    field.addEventListener("change", updateHelp);
  }

  form.addEventListener("mouseleave", () => {
    helpElement.textContent = HELP_FALLBACK;
  });

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

export function readFormState(form) {
  const data = new FormData(form);
  return {
    seed: String(data.get("seed") || "city-seed"),
    mapSize: Number(data.get("mapSize") || 768),
    districts: Number(data.get("districts") || 8),
    roadDensity: Number(data.get("roadDensity") || 6),
    waterMode: String(data.get("waterMode") || "random"),
    streetStyle: String(data.get("streetStyle") || "mixed"),
    landmarks: Number(data.get("landmarks") || 4),
  };
}
