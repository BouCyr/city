const RANGE_FIELDS = ["pointCount"];

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

export function readFormState(form) {
  const data = new FormData(form);
  return {
    seed: String(data.get("seed") || "city-seed"),
    pointCount: Number(data.get("pointCount") || 1000),
    waterSides: ["north", "east", "south", "west"].map((side) => ({
      name: side,
      enabled: data.getAll("waterSides").includes(side),
    })),
  };
}
