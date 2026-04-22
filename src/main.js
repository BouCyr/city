import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { generateCity } from "./generator/city-generator.js";
import { clearCanvas, drawReplayFrame } from "./render/canvas-renderer.js";

const CANVAS_SIZE = 768;
const REPLAY_DELAY_MS = 1000;
const form = document.querySelector("#generatorForm");
const canvas = document.querySelector("#cityCanvas");
const summary = document.querySelector("#mapSummary");
const replaySlider = document.querySelector("#replaySlider");
const replayLabel = document.querySelector("#replayLabel");
const playReplayButton = document.querySelector("#playReplayButton");
const prevReplayButton = document.querySelector("#prevReplayButton");
const nextReplayButton = document.querySelector("#nextReplayButton");
const stepTracker = createStepTracker({
  listElement: document.querySelector("#stepsList"),
  statusElement: document.querySelector("#statusBadge"),
});
let currentMap = null;
let replayTimer = null;

bindFormInteractions(form, document.querySelector("#helpText"));
canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;
clearCanvas(canvas);
syncReplayUi(null, 0);

replaySlider.addEventListener("input", () => {
  stopReplay();
  renderReplayIndex(Number(replaySlider.value));
});

prevReplayButton.addEventListener("click", () => {
  stopReplay();
  stepReplayBy(-1);
});

nextReplayButton.addEventListener("click", () => {
  stopReplay();
  stepReplayBy(1);
});

playReplayButton.addEventListener("click", () => {
  if (!currentMap || !currentMap.frames.length) {
    return;
  }

  if (replayTimer) {
    stopReplay();
    return;
  }

  playReplayButton.textContent = "Pause";
  let index = Number(replaySlider.value);
  renderReplayIndex(index);

  replayTimer = window.setInterval(() => {
    index += 1;
    if (index >= currentMap.frames.length) {
      stopReplay();
      return;
    }

    replaySlider.value = String(index);
    renderReplayIndex(index);
  }, REPLAY_DELAY_MS);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopReplay();

  const options = readFormState(form);
  const map = await generateCity({ ...options, mapSize: CANVAS_SIZE }, stepTracker);
  currentMap = map;
  syncReplayUi(map, map.frames.length - 1);
  renderReplayIndex(map.frames.length - 1);
});

form.requestSubmit();

function renderReplayIndex(index) {
  if (!currentMap) {
    clearCanvas(canvas);
    return;
  }

  const frame = currentMap.frames[index];
  drawReplayFrame(canvas, frame);
  replayLabel.textContent = frame.label;
  summary.textContent = describeFrame(currentMap, frame);
}

function syncReplayUi(map, index) {
  const max = map ? map.frames.length - 1 : 0;
  replaySlider.max = String(max);
  replaySlider.value = String(index);
  playReplayButton.disabled = !map;
  prevReplayButton.disabled = !map;
  nextReplayButton.disabled = !map;
  replayLabel.textContent = map ? map.frames[index].label : "Step 0 / Blank canvas";
}

function stopReplay() {
  if (!replayTimer) {
    playReplayButton.textContent = "Play";
    return;
  }

  window.clearInterval(replayTimer);
  replayTimer = null;
  playReplayButton.textContent = "Play";
}

function describeFrame(map, frame) {
  if (frame.type === "blank") {
    return "Blank canvas";
  }

  const frameMap = frame.map;
  const seaCellCount = frameMap.cells.filter((cell) => cell.isSea).length;
  return [
    `Seed ${map.seed}`,
    `${frameMap.points.length} points`,
    `${frameMap.cells.length} cells`,
    `${frameMap.edges.length} edges`,
    `${seaCellCount} sea cells`,
  ].join(" | ");
}

function stepReplayBy(delta) {
  if (!currentMap) {
    return;
  }

  const nextIndex = Math.min(Math.max(Number(replaySlider.value) + delta, 0), currentMap.frames.length - 1);
  replaySlider.value = String(nextIndex);
  renderReplayIndex(nextIndex);
}
