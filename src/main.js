import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { generateCity } from "./generator/city-generator.js";
import { drawCityMap, clearCanvas } from "./render/canvas-renderer.js";

const CANVAS_SIZE = 768;
const form = document.querySelector("#generatorForm");
const canvas = document.querySelector("#cityCanvas");
const summary = document.querySelector("#mapSummary");
const stepTracker = createStepTracker({
  listElement: document.querySelector("#stepsList"),
  statusElement: document.querySelector("#statusBadge"),
});

bindFormInteractions(form, document.querySelector("#helpText"));
canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;
clearCanvas(canvas);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const options = readFormState(form);
  const map = await generateCity({ ...options, mapSize: CANVAS_SIZE }, stepTracker);
  drawCityMap(canvas, map);
  summary.textContent = [
    `Seed ${map.seed}`,
    `${map.summary.pointCount} points`,
    `${map.summary.cellCount} cells`,
    `${map.summary.edgeCount} edges`,
    `${map.summary.seaCellCount} sea cells`,
  ].join(" | ");
});

form.requestSubmit();
