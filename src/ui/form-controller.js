const HELP_FALLBACK =
  "Hover or focus a field to inspect what it changes. The same seed and settings always reproduce the same Voronoi map.";

const RANGE_FIELDS = ["pointCount"];

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

  for (const helper of form.querySelectorAll("[data-help]")) {
    const updateHelp = () => {
      helpElement.textContent = helper.dataset.help || HELP_FALLBACK;
    };

    helper.addEventListener("mouseenter", updateHelp);
    helper.addEventListener("focusin", updateHelp);
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
    pointCount: Number(data.get("pointCount") || 500),
    waterSides: ["north", "east", "south", "west"].map((side) => ({
      name: side,
      enabled: data.getAll("waterSides").includes(side),
    })),
  };
}
