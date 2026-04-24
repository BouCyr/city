/*
 * WHAT: Orchestrate the browser app by wiring form input, replay controls, generation, and SVG viewport state.
 * HOW: Read normalized form options, generate deterministic frames, and redraw the selected frame while tracking zoom/pan.
 * WHY: The entrypoint keeps DOM-specific behavior in one place so the generator and renderer stay data-focused.
 */

import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { findCenterSeaLandPath } from "./generator/river-path.js";
import { clearSvg, drawReplayFrame } from "./render/svg-renderer.js";
import { GENERATION_STEPS } from "./generator/steps.js";
import { getMapGeometry, getMapLots } from "./generator/map-model.js";

const CANVAS_SIZE = 1000;
const REPLAY_DELAY_MS = 1000;
const REGENERATE_DEBOUNCE_MS = 250;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.25;
const PLAY_BUTTON_LABEL = "Play";
const PAUSE_BUTTON_LABEL = "Pause";
const REPLAY_START_INDEX = 0;
const VIEWPORT_FALLBACK_RATIO = 0.5;
const FLOW_OVERLAY_ID = "hoveredFlowOverlay";
const HOVER_NEIGHBOR_OVERLAY_ID = "hoveredNeighborOverlay";
const HOVER_NEIGHBOR_STROKE = "#7a5a2e";
const HOVER_NEIGHBOR_STROKE_WIDTH = 1.5;
const FLOW_STROKE = "#4f7cff";
const FLOW_STROKE_WIDTH = 4;
const HILLS_STEP_INDEX = 4;
const TOTAL_GENERATION_STEPS = GENERATION_STEPS.length;
const form = document.querySelector("#generatorForm");
const svg = document.querySelector("#cityMap");
const mapViewport = document.querySelector("#mapViewport");
const summary = document.querySelector("#mapSummary");
const backgroundTaskStatus = document.querySelector("#backgroundTaskStatus");
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
let activeWorker = null;
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

  cancelWorkerTask();
  seedInput.value = generateRandomSeed();
  form.requestSubmit();
});

bestSeedButton?.addEventListener("click", () => {
  if (!(seedInput instanceof HTMLInputElement)) {
    return;
  }

  runBestOfSeeds(50);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopReplay();
  const options = readFormState(form);
  runSingleGeneration(options);
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
  if (summary) {
    summary.textContent = describeFrame(currentMap, frame);
  }
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

function runSingleGeneration(options) {
  const requestId = ++generationToken;
  cancelWorkerTask();
  stepTracker.reset();
  setBackgroundTaskStatus(`Generating 0/${TOTAL_GENERATION_STEPS}`);
  setAsyncControlsDisabled(true);
  syncReplayUi(null, 0);
  resetViewport(CANVAS_SIZE);
  clearHoveredCell();

  activeWorker = createGenerationWorker(requestId, (message) => {
    if (message.requestId !== requestId) {
      return;
    }

    if (message.type === "generation-reset") {
      stepTracker.reset();
      setBackgroundTaskStatus(`Generating 0/${TOTAL_GENERATION_STEPS}`);
      return;
    }

    if (message.type === "generation-step-start") {
      stepTracker.startStep(message.index, message.status);
      setBackgroundTaskStatus(`Generating ${message.index + 1}/${TOTAL_GENERATION_STEPS}`);
      return;
    }

    if (message.type === "generation-step-complete") {
      stepTracker.finishStep(message.index, message.durationMs, message.status);
      renderInterimFrame(message.frame);
      setBackgroundTaskStatus(`Generating ${message.index + 1}/${TOTAL_GENERATION_STEPS}`);
      return;
    }

    if (message.type === "generation-finished-steps") {
      stepTracker.complete();
      setBackgroundTaskStatus("");
      return;
    }

    if (message.type === "generation-complete") {
      applyGeneratedMap(message.map);
      stepTracker.setCompletedRun(message.map.stepDurations || []);
      setBackgroundTaskStatus("");
      setAsyncControlsDisabled(false);
      teardownWorkerTask();
      return;
    }

    if (message.type === "task-error") {
      console.error("[generation-worker]", message.message);
      setBackgroundTaskStatus("Generation failed");
      setAsyncControlsDisabled(false);
      teardownWorkerTask();
    }
  });

  activeWorker.postMessage({
    type: "generate",
    requestId,
    options: { ...options, mapSize: CANVAS_SIZE },
  });
}

function runBestOfSeeds(sampleCount) {
  const requestId = ++generationToken;
  const options = readFormState(form);
  const baselineTributaryLength = currentMap?.rivers?.[1]?.length || 0;
  const baselineSeed = currentMap?.init?.seed || options.seed;

  stopReplay();
  cancelWorkerTask();
  setAsyncControlsDisabled(true);
  setBackgroundTaskStatus(`Best of ${sampleCount}: 0/${sampleCount}`);

  activeWorker = createGenerationWorker(requestId, (message) => {
    if (message.requestId !== requestId) {
      return;
    }

    if (message.type === "best-of-start") {
      setBackgroundTaskStatus(`Best of ${message.sampleCount}: 0/${message.sampleCount}`);
      return;
    }

    if (message.type === "best-of-progress") {
      setBackgroundTaskStatus(`Best of ${message.sampleCount}: ${message.completedCount}/${message.sampleCount}`);
      return;
    }

    if (message.type === "best-of-better") {
      renderBestCandidate(message.map);
      setBackgroundTaskStatus(`Best of ${message.sampleCount}: ${message.completedCount}/${message.sampleCount}`);
      return;
    }

    if (message.type === "best-of-complete") {
      if (message.improved && message.map) {
        if (seedInput instanceof HTMLInputElement && message.seed) {
          seedInput.value = message.seed;
        }
        applyGeneratedMap(message.map);
        stepTracker.setCompletedRun(message.map.stepDurations || []);
      }
      setBackgroundTaskStatus("");
      setAsyncControlsDisabled(false);
      teardownWorkerTask();
      return;
    }

    if (message.type === "task-error") {
      console.error("[generation-worker]", message.message);
      setBackgroundTaskStatus("Best of 50 failed");
      setAsyncControlsDisabled(false);
      teardownWorkerTask();
    }
  });

  activeWorker.postMessage({
    type: "best-of-50",
    requestId,
    sampleCount,
    options: { ...options, mapSize: CANVAS_SIZE },
    baseline: {
      seed: baselineSeed,
      tributaryLength: baselineTributaryLength,
    },
  });
}

function createGenerationWorker(requestId, onMessage) {
  const worker = new Worker(new URL("./generator/generation-worker.js", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (event) => {
    onMessage(event.data);
  });
  worker.addEventListener("error", (event) => {
    onMessage({
      type: "task-error",
      requestId,
      message: event.message || "Worker crashed",
    });
  });
  return worker;
}

function teardownWorkerTask() {
  if (!activeWorker) {
    return;
  }

  activeWorker.terminate();
  activeWorker = null;
}

function cancelWorkerTask() {
  teardownWorkerTask();
  setAsyncControlsDisabled(false);
  setBackgroundTaskStatus("");
}

function setAsyncControlsDisabled(isDisabled) {
  if (randomSeedButton) {
    randomSeedButton.disabled = isDisabled;
  }
  if (bestSeedButton) {
    bestSeedButton.disabled = isDisabled;
  }
}

function setBackgroundTaskStatus(text) {
  if (!backgroundTaskStatus) {
    return;
  }

  backgroundTaskStatus.textContent = text;
}

function renderInterimFrame(frame) {
  if (!frame || frame.type !== "map") {
    return;
  }

  currentMap = null;
  currentFrame = frame;
  hoveredCellId = null;
  drawReplayFrame(svg, frame, CANVAS_SIZE);
  applyViewport();
  clearHoveredCell();
  stepTracker.setSelectedStep(frame.stepIndex ?? -1);
}

function renderBestCandidate(map) {
  if (!map) {
    return;
  }

  currentMap = map;
  stepTracker.setCompletedRun(map.stepDurations || []);
  const finalIndex = Math.max(0, map.frames.length - 1);
  syncReplayUi(map, finalIndex);
  renderReplayIndex(finalIndex);
}

function applyGeneratedMap(map) {
  currentMap = map;
  resetViewport(map.meta.size);
  const finalIndex = Math.max(0, map.frames.length - 1);
  syncReplayUi(map, finalIndex);
  renderReplayIndex(finalIndex);
}

function describeFrame(map, frame) {
  if (frame.type === "blank") {
    return "Blank map";
  }

  const frameMap = frame.map;
  const { lots, segments } = getMapGeometry(frameMap);
  const areaLabel = Array.isArray(frameMap.lots) ? "lots" : "cells";
  const segmentLabel = Array.isArray(frameMap.segments) ? "segments" : "edges";
  const seaCellCount = lots.filter((lot) => lot.features.sea).length;
  const hillCount = lots.filter((lot) => lot.features.hill).length;
  const hillsideCount = lots.filter((lot) => lot.features.hillside).length;
  const riverCount = frameMap.rivers.length;
  return [
    frame.label,
    `Seed ${map.init.seed}`,
    `${frameMap.points.length} points`,
    `${lots.length} ${areaLabel}`,
    `${segments.length} ${segmentLabel}`,
    `${seaCellCount} sea ${areaLabel}`,
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
  clearNeighborOverlay();
  hoveredCellData.className = "cell-data empty";
  hoveredCellData.textContent = "Hover an area to inspect its data.";
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

  const target = event.target instanceof Element ? event.target.closest("[data-lot-id], [data-cell-id]") : null;
  const cellId = target
    ? Number(target.getAttribute("data-lot-id") || target.getAttribute("data-cell-id"))
    : hoveredCellId;
  if (!Number.isFinite(cellId)) {
    return null;
  }

  return getMapLots(currentFrame.map).find((cell) => cell.id === cellId) || null;
}

function renderHoveredCell(cell) {
  if (!(hoveredCellData instanceof HTMLElement)) {
    return;
  }

  hoveredCellId = cell.id;
  drawNeighborOverlay(cell);
  const isLotGeometry = Array.isArray(currentFrame?.map?.lots);
  const areaLabel = isLotGeometry ? "Lot" : "Cell";
  const segmentCollectionLabel = isLotGeometry ? "Segments" : "Edges";
  const features = Object.entries(cell.features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ") || "none";
  const boundarySides = cell.boundarySides.length ? cell.boundarySides.join(", ") : "none";
  const previewRiverPath = shouldShowRiverPreview() ? computeCenterSeaFlowPath(cell.id) : null;
  const rivers = currentFrame?.type === "map" ? currentFrame.map.rivers.filter((candidate) => candidate.cellIds.includes(cell.id)) : [];

  hoveredCellData.className = "cell-data";
  hoveredCellData.innerHTML = [
    createCellDataRow(areaLabel, String(cell.id)),
    createCellDataRow("Centroid", `${cell.centroid.x.toFixed(1)}, ${cell.centroid.y.toFixed(1)}`),
    createCellDataRow("Features", features),
    createCellDataRow("Hill", cell.features.hill ? "yes" : "no"),
    createCellDataRow("Hillside", cell.features.hillside ? "yes" : "no"),
    createCellDataRow("River Preview", shouldShowRiverPreview() ? describeFlowPath(previewRiverPath) : "hidden outside step 5"),
    createCellDataRow("Rivers", rivers.length ? rivers.map((river) => river.name).join(", ") : "none"),
    createCellDataRow("River Length", rivers.length ? rivers.map((river) => `${river.name}: ${river.length.toFixed(1)} px`).join(" | ") : "n/a"),
    createCellDataRow("Boundary Sides", boundarySides),
    createCellDataRow(segmentCollectionLabel, (cell.segmentIds || cell.edgeIds || []).join(", ") || "none"),
    createCellDataRow("Neighbors", getNeighborIds(cell).join(", ") || "none"),
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

function computeCenterSeaFlowPath(startCellId) {
  if (!currentFrame || currentFrame.type !== "map") {
    return null;
  }

  if (!shouldShowRiverPreview()) {
    return null;
  }
  return findCenterSeaLandPath(
    currentFrame.map.cells,
    currentFrame.map.edges,
    startCellId,
    currentFrame.map.meta.size,
    null,
    currentFrame.map.init?.params?.riverTurnAngle ?? 90,
  );
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

function drawNeighborOverlay(cell) {
  clearNeighborOverlay();
  const neighbors = getNeighborIds(cell);
  if (!neighbors.length) {
    return;
  }

  const lots = getMapLots(currentFrame?.map || {});
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", HOVER_NEIGHBOR_OVERLAY_ID);
  overlay.setAttribute("pointer-events", "none");

  const origin = cell.centroid;
  neighbors.forEach((neighborId) => {
    const neighbor = lots.find((lot) => lot.id === neighborId);
    if (!neighbor) {
      return;
    }

    overlay.append(createNeighborArrow(origin, neighbor.centroid));
  });

  svg.append(overlay);
}

function clearNeighborOverlay() {
  svg.querySelector(`#${HOVER_NEIGHBOR_OVERLAY_ID}`)?.remove();
}

function createNeighborArrow(from, to) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
  line.setAttribute("stroke", HOVER_NEIGHBOR_STROKE);
  line.setAttribute("stroke-width", String(HOVER_NEIGHBOR_STROKE_WIDTH));
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", "0.85");

  return line;
}

function getNeighborIds(cell) {
  if (!cell) {
    return [];
  }

  return cell.neighborLotIds || cell.neighborCellIds || [];
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
