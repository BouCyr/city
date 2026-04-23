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
const NEIGHBOR_CELL_OPACITY = 0.62;
const DIMMED_CELL_OPACITY = 0.28;
const DIMMED_RIVER_OPACITY = 0.14;
const HIGHLIGHT_RIVER_WIDTH_SCALE = 1.35;
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

  hoveredCellData.className = "cell-data";
  hoveredCellData.innerHTML = [
    createCellDataRow("Cell", String(cell.id)),
    createCellDataRow("Centroid", `${cell.centroid.x.toFixed(1)}, ${cell.centroid.y.toFixed(1)}`),
    createCellDataRow("Features", features),
    createCellDataRow("Boundary Sides", boundarySides),
    createCellDataRow("Edges", cell.edgeIds.join(", ") || "none"),
    createCellDataRow("Neighbors", cell.neighborCellIds.join(", ") || "none"),
  ].join("");
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
  const cellElements = svg.querySelectorAll("[data-cell-id]");
  const riverElements = svg.querySelectorAll("[data-river-id]");

  if (!Number.isFinite(cellId)) {
    cellElements.forEach((element) => {
      element.style.opacity = "1";
    });
    riverElements.forEach((element) => {
      element.style.opacity = "1";
      element.style.strokeWidth = element.getAttribute("data-base-width") || "";
    });
    return;
  }

  const neighborCellIds = collectNeighborCellIds(cellId);
  cellElements.forEach((element) => {
    const currentCellId = Number(element.getAttribute("data-cell-id"));
    if (currentCellId === cellId) {
      element.style.opacity = "1";
      return;
    }

    element.style.opacity = neighborCellIds.has(currentCellId) ? String(NEIGHBOR_CELL_OPACITY) : String(DIMMED_CELL_OPACITY);
  });

  const highlightedRiverIds = collectHighlightedRiverIds(cellId);
  riverElements.forEach((element) => {
    const riverId = Number(element.getAttribute("data-river-id"));
    const baseWidth = Number(element.getAttribute("data-base-width")) || 0;
    const isHighlighted = highlightedRiverIds.has(riverId);
    element.style.opacity = highlightedRiverIds.size === 0 || isHighlighted ? "1" : String(DIMMED_RIVER_OPACITY);
    element.style.strokeWidth = isHighlighted ? String(baseWidth * HIGHLIGHT_RIVER_WIDTH_SCALE) : String(baseWidth);
  });
}

function collectNeighborCellIds(cellId) {
  if (!currentFrame || currentFrame.type !== "map") {
    return new Set();
  }

  const hoveredCell = currentFrame.map.cells.find((cell) => cell.id === cellId);
  return new Set(hoveredCell?.neighborCellIds || []);
}

function collectHighlightedRiverIds(cellId) {
  if (!currentFrame || currentFrame.type !== "map") {
    return new Set();
  }

  const { rivers } = currentFrame.map;
  const highlighted = new Set(
    rivers
      .filter((river) => river.cellIds.includes(cellId))
      .map((river) => river.id),
  );

  if (highlighted.size === 0) {
    return highlighted;
  }

  const parentByRiverId = new Map();
  rivers.forEach((river) => {
    if (river.termination !== "merge") {
      return;
    }

    const parent = rivers.find((candidate) => candidate.id !== river.id && candidate.cellIds.includes(river.endCellId));
    if (parent) {
      parentByRiverId.set(river.id, parent.id);
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    rivers.forEach((river) => {
      const parentId = parentByRiverId.get(river.id);
      if (parentId !== undefined && highlighted.has(parentId) && !highlighted.has(river.id)) {
        highlighted.add(river.id);
        changed = true;
      }
    });
  }

  return highlighted;
}
