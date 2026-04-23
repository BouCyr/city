/*
 * WHAT: Orchestrate the browser app by wiring form input, replay controls, generation, and SVG viewport state.
 * HOW: Read normalized form options, generate deterministic frames, and redraw the selected frame while tracking zoom/pan.
 * WHY: The entrypoint keeps DOM-specific behavior in one place so the generator and renderer stay data-focused.
 */

import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { generateCity } from "./generator/city-generator.js";
import { clearSvg, drawReplayFrame } from "./render/svg-renderer.js";

const CANVAS_SIZE = 768;
const REPLAY_DELAY_MS = 1000;
const REGENERATE_DEBOUNCE_MS = 250;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.25;
const PLAY_BUTTON_LABEL = "Play";
const PAUSE_BUTTON_LABEL = "Pause";
const REPLAY_START_INDEX = 0;
const VIEWPORT_FALLBACK_RATIO = 0.5;
const form = document.querySelector("#generatorForm");
const svg = document.querySelector("#cityMap");
const mapViewport = document.querySelector("#mapViewport");
const summary = document.querySelector("#mapSummary");
const replaySlider = document.querySelector("#replaySlider");
const playReplayButton = document.querySelector("#playReplayButton");
const prevReplayButton = document.querySelector("#prevReplayButton");
const nextReplayButton = document.querySelector("#nextReplayButton");
const zoomInButton = document.querySelector("#zoomInButton");
const zoomOutButton = document.querySelector("#zoomOutButton");
const resetViewButton = document.querySelector("#resetViewButton");
const stepTracker = createStepTracker({
  listElement: document.querySelector("#stepsList"),
  statusElement: document.querySelector("#statusBadge"),
  onStepSelect: (stepIndex) => {
    stopReplay();
    const replayIndex = findReplayIndexForStep(stepIndex);
    replaySlider.value = String(replayIndex);
    renderReplayIndex(replayIndex);
  },
});
let currentMap = null;
let replayTimer = null;
let regenerateTimer = null;
let generationToken = 0;
let currentFrameIndex = 0;
let isDragging = false;
let dragPointerId = null;
let dragStart = null;
const viewportState = createViewportState(CANVAS_SIZE);

bindFormInteractions(form);
clearSvg(svg, CANVAS_SIZE);
applyViewport();
syncReplayUi(null, 0);

replaySlider.addEventListener("input", () => {
  stopReplay();
  renderReplayIndex(Number(replaySlider.value));
});

for (const field of form.elements) {
  if (!(field instanceof HTMLElement) || !field.name) {
    continue;
  }

  const eventName = field instanceof HTMLInputElement && field.type === "text" ? "input" : "change";
  field.addEventListener(eventName, scheduleRegeneration);
}

prevReplayButton.addEventListener("click", () => {
  stopReplay();
  stepReplayBy(-1);
});

nextReplayButton.addEventListener("click", () => {
  stopReplay();
  stepReplayBy(1);
});

zoomInButton.addEventListener("click", () => zoomBy(ZOOM_STEP));
zoomOutButton.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
resetViewButton.addEventListener("click", () => {
  resetViewport();
});

playReplayButton.addEventListener("click", () => {
  if (!currentMap || !currentMap.frames.length) {
    return;
  }

  if (replayTimer) {
    stopReplay();
    return;
  }

  startReplay();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopReplay();
  const token = ++generationToken;

  const options = readFormState(form);
  const map = await generateCity({ ...options, mapSize: CANVAS_SIZE }, stepTracker);
  if (token !== generationToken) {
    return;
  }
  currentMap = map;
  resetViewport(map.meta.size);
  syncReplayUi(map, 0);
  renderReplayIndex(0);
  startReplay();
});

mapViewport.addEventListener("wheel", handleViewportWheel, { passive: false });
mapViewport.addEventListener("pointerdown", handlePointerDown);
mapViewport.addEventListener("pointermove", handlePointerMove);
mapViewport.addEventListener("pointerup", handlePointerUp);
mapViewport.addEventListener("pointercancel", handlePointerUp);
mapViewport.addEventListener("pointerleave", handlePointerUp);

form.requestSubmit();

/**
 * WHAT: Draw one replay frame and synchronize the side-panel UI with it.
 * HOW: Clear or redraw the SVG, update the summary text, and select the matching generation step.
 * WHY: Replay navigation should update the viewport, summary, and step list as one consistent action.
 */
function renderReplayIndex(index) {
  currentFrameIndex = index;
  if (!currentMap) {
    clearSvg(svg, CANVAS_SIZE);
    applyViewport();
    return;
  }

  const frame = currentMap.frames[index];
  drawReplayFrame(svg, frame, currentMap.meta.size);
  applyViewport();
  summary.textContent = describeFrame(currentMap, frame);
  stepTracker.setSelectedStep(frame.stepIndex ?? -1);
}

function syncReplayUi(map, index) {
  const max = map ? map.frames.length - 1 : 0;
  replaySlider.max = String(max);
  replaySlider.value = String(index);
  playReplayButton.disabled = !map;
  prevReplayButton.disabled = !map;
  nextReplayButton.disabled = !map;
}

function stopReplay() {
  if (!replayTimer) {
    playReplayButton.textContent = PLAY_BUTTON_LABEL;
    return;
  }

  window.clearInterval(replayTimer);
  replayTimer = null;
  playReplayButton.textContent = PLAY_BUTTON_LABEL;
}

/**
 * WHAT: Start playback from the first replay frame and advance at a fixed cadence.
 * HOW: Reset the slider to frame zero, redraw immediately, then step forward on an interval timer.
 * WHY: Autoplay should always show a complete generation run rather than resuming mid-stream unpredictably.
 */
function startReplay() {
  if (!currentMap || !currentMap.frames.length) {
    return;
  }

  stopReplay();
  replaySlider.value = String(REPLAY_START_INDEX);
  renderReplayIndex(REPLAY_START_INDEX);
  playReplayButton.textContent = PAUSE_BUTTON_LABEL;
  let index = REPLAY_START_INDEX;

  replayTimer = window.setInterval(() => {
    index += 1;
    if (index >= currentMap.frames.length) {
      stopReplay();
      return;
    }

    replaySlider.value = String(index);
    renderReplayIndex(index);
  }, REPLAY_DELAY_MS);
}

function describeFrame(map, frame) {
  if (frame.type === "blank") {
    return "Blank map";
  }

  const frameMap = frame.map;
  const seaCellCount = frameMap.cells.filter((cell) => cell.features.sea).length;
  const riverCount = frameMap.rivers?.length || 0;
  return [
    frame.label,
    `Seed ${map.init.seed}`,
    `${frameMap.points.length} points`,
    `${frameMap.cells.length} cells`,
    `${frameMap.edges.length} edges`,
    `${seaCellCount} sea cells`,
    `${riverCount} rivers`,
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

function scheduleRegeneration() {
  window.clearTimeout(regenerateTimer);
  regenerateTimer = window.setTimeout(() => {
    form.requestSubmit();
  }, REGENERATE_DEBOUNCE_MS);
}

function findReplayIndexForStep(stepIndex) {
  if (!currentMap) {
    return 0;
  }

  const replayIndex = currentMap.frames.findIndex((frame) => frame.stepIndex === stepIndex);
  return replayIndex >= 0 ? replayIndex : 0;
}

function handleViewportWheel(event) {
  event.preventDefault();
  const direction = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  const targetSize = currentMap?.meta.size || CANVAS_SIZE;
  const focusPoint = getFocusPoint(event, targetSize);
  zoomBy(direction, focusPoint, targetSize);
}

function handlePointerDown(event) {
  if (event.button !== 0 || !currentMap) {
    return;
  }

  isDragging = true;
  dragPointerId = event.pointerId;
  dragStart = { x: event.clientX, y: event.clientY, offsetX: viewportState.x, offsetY: viewportState.y };
  mapViewport.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!isDragging || event.pointerId !== dragPointerId) {
    return;
  }

  const targetSize = currentMap?.meta.size || CANVAS_SIZE;
  const deltaX = (event.clientX - dragStart.x) * (viewportState.width / mapViewport.clientWidth);
  const deltaY = (event.clientY - dragStart.y) * (viewportState.height / mapViewport.clientHeight);
  viewportState.x = dragStart.offsetX - deltaX;
  viewportState.y = dragStart.offsetY - deltaY;
  clampViewport(targetSize);
  applyViewport();
}

function handlePointerUp(event) {
  if (event.pointerId !== dragPointerId) {
    return;
  }

  isDragging = false;
  dragPointerId = null;
  dragStart = null;
  if (mapViewport.hasPointerCapture(event.pointerId)) {
    mapViewport.releasePointerCapture(event.pointerId);
  }
}

/**
 * WHAT: Zoom the SVG viewBox around a focus point while keeping the viewport inside map bounds.
 * HOW: Convert the desired zoom factor into a new viewBox rectangle anchored at the pointer or viewport center.
 * WHY: Users need precise inspection of dense maps without losing their place in the replay.
 */
function zoomBy(factor, focusPoint = null, size = currentMap?.meta.size || CANVAS_SIZE) {
  const nextZoom = clamp(viewportState.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const appliedFactor = nextZoom / viewportState.zoom;

  if (appliedFactor === 1) {
    return;
  }

  const anchor = focusPoint || {
    x: viewportState.x + viewportState.width * VIEWPORT_FALLBACK_RATIO,
    y: viewportState.y + viewportState.height * VIEWPORT_FALLBACK_RATIO,
  };
  const nextWidth = size / nextZoom;
  const nextHeight = size / nextZoom;
  const ratioX = (anchor.x - viewportState.x) / viewportState.width;
  const ratioY = (anchor.y - viewportState.y) / viewportState.height;

  viewportState.zoom = nextZoom;
  viewportState.width = nextWidth;
  viewportState.height = nextHeight;
  viewportState.x = anchor.x - nextWidth * ratioX;
  viewportState.y = anchor.y - nextHeight * ratioY;
  clampViewport(size);
  applyViewport();
}

function resetViewport(size = currentMap?.meta.size || CANVAS_SIZE) {
  viewportState.zoom = 1;
  viewportState.width = size;
  viewportState.height = size;
  viewportState.x = 0;
  viewportState.y = 0;
  applyViewport();
}

function applyViewport() {
  svg.setAttribute("viewBox", `${viewportState.x} ${viewportState.y} ${viewportState.width} ${viewportState.height}`);
  const isZoomed = viewportState.zoom > MIN_ZOOM;
  zoomOutButton.disabled = !currentMap || viewportState.zoom <= MIN_ZOOM;
  zoomInButton.disabled = !currentMap || viewportState.zoom >= MAX_ZOOM;
  resetViewButton.disabled = !currentMap || !isZoomed;
  mapViewport.classList.toggle("is-dragging", isDragging);
}

function getFocusPoint(event, size) {
  const bounds = mapViewport.getBoundingClientRect();
  const ratioX = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : VIEWPORT_FALLBACK_RATIO;
  const ratioY = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : VIEWPORT_FALLBACK_RATIO;

  return {
    x: viewportState.x + viewportState.width * ratioX,
    y: viewportState.y + viewportState.height * ratioY,
  };
}

function clampViewport(size) {
  viewportState.width = Math.min(viewportState.width, size);
  viewportState.height = Math.min(viewportState.height, size);
  viewportState.x = clamp(viewportState.x, 0, size - viewportState.width);
  viewportState.y = clamp(viewportState.y, 0, size - viewportState.height);
}

function createViewportState(size) {
  return {
    zoom: 1,
    x: 0,
    y: 0,
    width: size,
    height: size,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
