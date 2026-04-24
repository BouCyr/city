/*
 * WHAT: Orchestrate the browser app by wiring form input, replay controls, generation, and SVG viewport state.
 * HOW: Read normalized form options, generate deterministic frames, and redraw the selected frame while tracking zoom/pan.
 * WHY: The entrypoint keeps DOM-specific behavior in one place so the generator and renderer stay data-focused.
 */

import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { generateCity } from "./generator/city-generator.js";
import { findCenterSeaLandPath } from "./generator/river-path.js";
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
const DOTTED_EDGE_PATTERN = "4 6";
const FLOW_OVERLAY_ID = "hoveredFlowOverlay";
const FLOW_STROKE = "#4f7cff";
const FLOW_STROKE_WIDTH = 4;
const HILLS_STEP_INDEX = 4;
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
const hoveredCellData = document.querySelector("#hoveredCellData");
const randomSeedButton = document.querySelector("#randomSeedButton");
const bestSeedButton = document.querySelector("#bestSeedButton");
const seedInput = document.querySelector("#seed");
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
let currentFrame = null;
let hoveredCellId = null;
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

randomSeedButton?.addEventListener("click", () => {
  if (!(seedInput instanceof HTMLInputElement)) {
    return;
  }

  seedInput.value = generateRandomSeed();
  form.requestSubmit();
});

bestSeedButton?.addEventListener("click", async () => {
  if (!(seedInput instanceof HTMLInputElement)) {
    return;
  }

  bestSeedButton.disabled = true;
  randomSeedButton && (randomSeedButton.disabled = true);

  try {
    const bestSeed = await findBestSeedFromSamples(50);
    if (!bestSeed) {
      return;
    }

    seedInput.value = bestSeed;
    form.requestSubmit();
  } finally {
    bestSeedButton.disabled = false;
    randomSeedButton && (randomSeedButton.disabled = false);
  }
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
  const finalIndex = Math.max(0, map.frames.length - 1);
  syncReplayUi(map, finalIndex);
  renderReplayIndex(finalIndex);
});

mapViewport.addEventListener("wheel", handleViewportWheel, { passive: false });
mapViewport.addEventListener("pointerdown", handlePointerDown);
mapViewport.addEventListener("pointermove", handlePointerMove);
mapViewport.addEventListener("pointerup", handlePointerUp);
mapViewport.addEventListener("pointercancel", handlePointerUp);
mapViewport.addEventListener("pointerleave", handlePointerUp);
svg.addEventListener("pointermove", handleCellHover);
svg.addEventListener("pointerleave", clearHoveredCell);
svg.addEventListener("click", handleCellClick);

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
  currentFrame = frame;
  drawReplayFrame(svg, frame, currentMap.meta.size);
  applyViewport();
  clearHoveredCell();
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

function generateRandomSeed() {
  return Math.random().toString(36).slice(2, 10);
}

async function findBestSeedFromSamples(sampleCount) {
  const baseOptions = readFormState(form);
  const silentStepTracker = createSilentStepTracker();
  let bestCandidate = null;

  for (let index = 0; index < sampleCount; index += 1) {
    const seed = generateRandomSeed();
    const map = await generateCity(
      { ...baseOptions, seed, mapSize: CANVAS_SIZE },
      silentStepTracker,
    );
    const tributary = map.rivers?.[1] || null;
    const tributaryLength = tributary?.length || 0;

    if (!bestCandidate || tributaryLength > bestCandidate.tributaryLength) {
      bestCandidate = { seed, tributaryLength };
    }
  }

  return bestCandidate?.seed || null;
}

function createSilentStepTracker() {
  return {
    reset() {},
    async advance(_index, _status, work) {
      return work();
    },
    complete() {},
    setSelectedStep() {},
  };
}

function describeFrame(map, frame) {
  if (frame.type === "blank") {
    return "Blank map";
  }

  const frameMap = frame.map;
  const seaCellCount = frameMap.cells.filter((cell) => cell.features.sea).length;
  const hillCount = frameMap.cells.filter((cell) => cell.features.hill).length;
  const hillsideCount = frameMap.cells.filter((cell) => cell.features.hillside).length;
  const riverCount = frameMap.rivers.length;
  return [
    frame.label,
    `Seed ${map.init.seed}`,
    `${frameMap.points.length} points`,
    `${frameMap.cells.length} cells`,
    `${frameMap.edges.length} edges`,
    `${seaCellCount} sea cells`,
    `${hillCount} hills`,
    `${hillsideCount} hillsides`,
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

function handleCellHover(event) {
  const cell = getCellFromEvent(event);
  if (!cell) {
    clearHoveredCell();
    return;
  }

  renderHoveredCell(cell);
}

function clearHoveredCell() {
  if (!(hoveredCellData instanceof HTMLElement)) {
    return;
  }

  hoveredCellId = null;
  clearFlowOverlay();
  applyHoverPresentation(null);
  hoveredCellData.className = "cell-data empty";
  hoveredCellData.textContent = "Hover a cell to inspect its data.";
}

function handleCellClick(event) {
  const cell = getCellFromEvent(event);
  if (!cell) {
    return;
  }

  focusCell(cell, currentFrame?.map?.meta.size || currentMap?.meta.size || CANVAS_SIZE);
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

function getCellFromEvent(event) {
  if (!currentFrame || currentFrame.type !== "map") {
    return null;
  }

  const target = event.target instanceof Element ? event.target.closest("[data-cell-id]") : null;
  const cellId = target ? Number(target.getAttribute("data-cell-id")) : hoveredCellId;
  if (!Number.isFinite(cellId)) {
    return null;
  }

  return currentFrame.map.cells.find((cell) => cell.id === cellId) || null;
}

function renderHoveredCell(cell) {
  if (!(hoveredCellData instanceof HTMLElement)) {
    return;
  }

  hoveredCellId = cell.id;
  applyHoverPresentation(cell.id);
  const features = Object.entries(cell.features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ") || "none";
  const boundarySides = cell.boundarySides.length ? cell.boundarySides.join(", ") : "none";
  const previewRiverPath = shouldShowRiverPreview() ? computeCenterSeaFlowPath(cell.id) : null;
  const rivers = currentFrame?.type === "map" ? currentFrame.map.rivers.filter((candidate) => candidate.cellIds.includes(cell.id)) : [];

  hoveredCellData.className = "cell-data";
  hoveredCellData.innerHTML = [
    createCellDataRow("Cell", String(cell.id)),
    createCellDataRow("Centroid", `${cell.centroid.x.toFixed(1)}, ${cell.centroid.y.toFixed(1)}`),
    createCellDataRow("Features", features),
    createCellDataRow("Hill", cell.features.hill ? "yes" : "no"),
    createCellDataRow("Hillside", cell.features.hillside ? "yes" : "no"),
    createCellDataRow("River Preview", shouldShowRiverPreview() ? describeFlowPath(previewRiverPath) : "hidden outside step 5"),
    createCellDataRow("Rivers", rivers.length ? rivers.map((river) => river.name).join(", ") : "none"),
    createCellDataRow("River Length", rivers.length ? rivers.map((river) => `${river.name}: ${river.length.toFixed(1)} px`).join(" | ") : "n/a"),
    createCellDataRow("Boundary Sides", boundarySides),
    createCellDataRow("Edges", cell.edgeIds.join(", ") || "none"),
    createCellDataRow("Neighbors", cell.neighborCellIds.join(", ") || "none"),
  ].join("");
  drawFlowOverlay(previewRiverPath);
}

function createCellDataRow(label, value) {
  return `
    <div class="cell-data-row">
      <span class="cell-data-label">${label}</span>
      <span>${value}</span>
    </div>
  `;
}

function focusCell(cell, size) {
  const bounds = getCellBounds(cell);
  const padding = 18;
  const cellWidth = bounds.maxX - bounds.minX;
  const cellHeight = bounds.maxY - bounds.minY;
  const targetSpan = clamp(Math.max(cellWidth, cellHeight) + padding * 2, size / MAX_ZOOM, size);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  viewportState.width = targetSpan;
  viewportState.height = targetSpan;
  viewportState.zoom = size / targetSpan;
  viewportState.x = centerX - targetSpan / 2;
  viewportState.y = centerY - targetSpan / 2;
  clampViewport(size);
  applyViewport();
}

function getCellBounds(cell) {
  return cell.polygon.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

function applyHoverPresentation(cellId) {
  const edgeElements = svg.querySelectorAll("[data-edge-id]");

  if (!Number.isFinite(cellId)) {
    edgeElements.forEach((element) => {
      element.style.strokeDasharray = "";
    });
    return;
  }

  const highlightedCellIds = collectHighlightedCellIds(cellId);
  edgeElements.forEach((element) => {
    const leftCellId = parseOptionalCellId(element.getAttribute("data-left-cell-id"));
    const rightCellId = parseOptionalCellId(element.getAttribute("data-right-cell-id"));
    if (highlightedCellIds.has(leftCellId) || highlightedCellIds.has(rightCellId)) {
      element.style.strokeDasharray = "";
      return;
    }

    element.style.strokeDasharray = DOTTED_EDGE_PATTERN;
  });
}

function collectHighlightedCellIds(cellId) {
  if (!currentFrame || currentFrame.type !== "map") {
    return new Set();
  }

  const hoveredCell = currentFrame.map.cells.find((cell) => cell.id === cellId);
  return new Set([cellId, ...(hoveredCell?.neighborCellIds || [])]);
}

function parseOptionalCellId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeCenterSeaFlowPath(startCellId) {
  if (!currentFrame || currentFrame.type !== "map") {
    return null;
  }

  if (!shouldShowRiverPreview()) {
    return null;
  }
  return findCenterSeaLandPath(currentFrame.map.cells, currentFrame.map.edges, startCellId, currentFrame.map.meta.size);
}

function describeFlowPath(flowPath) {
  if (!flowPath) {
    return "no valid path";
  }

  return `${flowPath.cellIds.length - 1} steps`;
}

function drawFlowOverlay(flowPath) {
  clearFlowOverlay();
  if (!flowPath || flowPath.points.length < 2) {
    return;
  }

  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", FLOW_OVERLAY_ID);
  overlay.setAttribute("pointer-events", "none");

  appendFlowPolyline(overlay, flowPath, FLOW_STROKE);
  svg.append(overlay);
}

function clearFlowOverlay() {
  svg.querySelector(`#${FLOW_OVERLAY_ID}`)?.remove();
}

function toSvgPoints(points) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function appendFlowPolyline(overlay, flowPath, stroke) {
  if (!flowPath || flowPath.points.length < 2) {
    return;
  }

  const outline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  outline.setAttribute("points", toSvgPoints(flowPath.points));
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "rgba(255, 255, 255, 0.75)");
  outline.setAttribute("stroke-width", String(FLOW_STROKE_WIDTH + 2));
  outline.setAttribute("stroke-linecap", "round");
  outline.setAttribute("stroke-linejoin", "round");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", toSvgPoints(flowPath.points));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", String(FLOW_STROKE_WIDTH));
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");

  overlay.append(outline, line);
}

function shouldShowRiverPreview() {
  return Boolean(currentFrame && currentFrame.type === "map" && currentFrame.stepIndex === HILLS_STEP_INDEX);
}
