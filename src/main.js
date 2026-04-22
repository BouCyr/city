import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { generateCity } from "./generator/city-generator.js";
import { drawCityMap, clearCanvas } from "./render/canvas-renderer.js";

const form = document.querySelector("#generatorForm");
const canvas = document.querySelector("#cityCanvas");
const summary = document.querySelector("#mapSummary");
const stepTracker = createStepTracker({
  listElement: document.querySelector("#stepsList"),
  statusElement: document.querySelector("#statusBadge"),
});

bindFormInteractions(form, document.querySelector("#helpText"));
clearCanvas(canvas, "Adjust parameters and generate a city.");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const options = readFormState(form);
  canvas.width = options.mapSize;
  canvas.height = options.mapSize;

  const map = await generateCity(options, stepTracker);
  drawCityMap(canvas, map);
  summary.textContent = [
    `Seed ${map.seed}`,
    `${map.districts.length} districts`,
    `${map.roads.length} roads`,
    `${map.landmarks.length} landmarks`,
    map.water.type === "none" ? "dry terrain" : `${map.water.type} terrain`,
  ].join(" | ");
});

form.requestSubmit();
