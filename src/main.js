/*
 * WHAT: Orchestrate the browser app by wiring form input, step selection, generation, and SVG viewport state.
 * HOW: Read normalized form options, generate deterministic frames, and redraw the selected frame while tracking mouse zoom/pan.
 * WHY: The entrypoint keeps DOM-specific behavior in one place so the generator and renderer stay data-focused.
 */

import { readFormState, bindFormInteractions } from "./ui/form-controller.js";
import { createStepTracker } from "./ui/step-tracker.js";
import { findCenterSeaLandPath } from "./generator/river-path.js";
import { clearSvg, drawReplayFrame } from "./render/svg-renderer.js";
import { GENERATION_STEPS } from "./generator/steps.js";
import { getMapLots } from "./generator/map-model.js";

const CANVAS_SIZE = 3000;
const REGENERATE_DEBOUNCE_MS = 250;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.25;
const VIEWPORT_FALLBACK_RATIO = 0.5;
const FLOW_OVERLAY_ID = "hoveredFlowOverlay";
const HOVER_NEIGHBOR_OVERLAY_ID = "hoveredNeighborOverlay";
const HOVER_RIVER_OVERLAY_ID = "hoveredRiverOverlay";
const HOVER_NEIGHBOR_STROKE = "#7a5a2e";
const HOVER_NEIGHBOR_STROKE_WIDTH = 4.5;
const FLOW_STROKE = "#4f7cff";
const FLOW_STROKE_WIDTH = 12;
const RIVER_HOVER_STROKE = "#1e56c5";
const RIVER_HOVER_GLOW = "rgba(255, 255, 255, 0.82)";
const HILLS_STEP_INDEX = 5;
const TOTAL_GENERATION_STEPS = GENERATION_STEPS.length;
const form = document.querySelector("#generatorForm");
const svg = document.querySelector("#cityMap");
const mapViewport = document.querySelector("#mapViewport");
const backgroundTaskStatus = document.querySelector("#backgroundTaskStatus");
const mapSummary = document.querySelector(".map-summary");
const seaCellCount = document.querySelector("#seaCellCount");
const landCellCount = document.querySelector("#landCellCount");
const generationTimeValue = document.querySelector("#generationTimeValue");
const primaryRiverSummary = document.querySelector("#primaryRiverSummary");
const primaryRiverLabel = document.querySelector("#primaryRiverLabel");
const primaryRiverLength = document.querySelector("#primaryRiverLength");
const tributaryRiverSummary = document.querySelector("#tributaryRiverSummary");
const tributaryRiverLabel = document.querySelector("#tributaryRiverLabel");
const tributaryRiverLength = document.querySelector("#tributaryRiverLength");
const hoveredCellData = document.querySelector("#hoveredCellData");
const randomSeedButton = document.querySelector("#randomSeedButton");
const bestSeedButton = document.querySelector("#bestSeedButton");
const seedInput = document.querySelector("#seed");
const controlHelpText = document.querySelector("#controlHelpText");
const stepTracker = createStepTracker({
  listElement: document.querySelector("#stepsList"),
  statusElement: document.querySelector("#statusBadge"),
  onStepSelect: (stepIndex) => {
    selectedStepIndex = stepIndex;
    renderStepIndex(stepIndex);
  },
});
let currentMap = null;
let regenerateTimer = null;
let generationToken = 0;
let activeWorker = null;
let currentFrame = null;
let selectedStepIndex = GENERATION_STEPS.length - 1;
let hoveredCellId = null;
let hoveredRiverId = null;
let isDragging = false;
let dragPointerId = null;
let dragStart = null;
const viewportState = createViewportState(CANVAS_SIZE);
const CONTROL_HELP_TEXT = {
  pointCount: "How many seed points are scattered before Voronoi generation. Higher values create denser and smaller cells. Square grid mode snaps this to the nearest perfect square.",
  scatterPaddingRatio: "Border padding ratio for the point scatterer. Higher values shrink the usable area, which keeps the density more even near map edges.",
  scatterAlgorithm: "Select the scatter algorithm for step 1.1. Different algorithms produce different point distributions and downstream map geometry.",
  poissonSpacingRatio: "Density multiplier for Poisson disk spacing. Higher values push accepted points farther apart, so the result looks less crowded but more structured.",
  poissonMaxAttempts: "Candidate attempts per active Poisson sample before it is retired. Higher values improve fill quality at higher CPU cost.",
  poissonPaddingRatio: "Border padding ratio for Poisson disk sampling. Higher values reserve more empty space around the edge before points are accepted.",
  waterSides: "Select borders that can flood inward. More active sides usually increases sea coverage.",
  waterReachRatio: "Maximum inland reach used during water expansion. Higher values let water penetrate farther.",
  waterExpansionBase: "Base chance for water to expand from sea-adjacent cells into land cells.",
  waterExpansionEdgeWeight: "Additional flooding pressure near enabled map borders.",
  waterPressureRangeRatio: "Distance range where edge pressure meaningfully affects water spread.",
  waterCenterBiasRadiusRatio: "Bias against flooding the map center. Higher values keep center landier for longer.",
  relaxPaddingRatio: "Padding ratio applied during Lloyd relaxation to keep adjusted points away from map edges.",
  hillCount: "Number of inland cells flagged as hill sources.",
  hillSeaDistance: "Minimum graph distance from sea required for a cell to qualify as a hill.",
  hillsideRadius: "How many neighbor rings around each hill are marked as hillside.",
  riverTurnAngle: "Minimum turn angle constraint while tracing rivers. Larger values enforce smoother paths.",
  primaryRiverWidth: "Base render width for the primary river in meters before tributary merge adjustments.",
  tributarySourceRiverDistance: "Minimum distance between tributary source candidates and the primary river.",
  tributaryMergeSeaDistance: "Minimum upstream distance from sea/outlet before tributary merge is allowed.",
  tributaryWidthRatio: "Relative tributary width compared to the primary river width.",
  primaryMergeWidthGain: "Additional width in meters added to the primary river downstream after tributary merge.",
  tessellateAlgorithm: "Choose how step 1.12 creates sublots. Straight bisection uses straight split chords, Curved bisection follows a circular arc constrained by the endpoint normals, and Poisson Voronoi seeds the lot with Poisson points plus existing boundary vertices before clipping Voronoi cells to the lot boundary.",
};

bindFormInteractions(form);
clearSvg(svg, CANVAS_SIZE);
applyViewport();

for (const field of form.elements) {
  if (!(field instanceof HTMLElement) || !field.name) {
    continue;
  }

  const eventName = field instanceof HTMLInputElement && field.type === "text" ? "input" : "change";
  field.addEventListener(eventName, scheduleRegeneration);
}

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
  const options = readFormState(form);
  runSingleGeneration(options);
});

mapViewport.addEventListener("wheel", handleViewportWheel, { passive: false });
mapViewport.addEventListener("pointerdown", handlePointerDown);
mapViewport.addEventListener("pointermove", handlePointerMove);
mapViewport.addEventListener("pointerup", handlePointerUp);
mapViewport.addEventListener("pointercancel", handlePointerUp);
mapViewport.addEventListener("pointerleave", handlePointerUp);
svg.addEventListener("pointermove", handleMapHover);
svg.addEventListener("pointerleave", clearHoverState);
mapSummary?.addEventListener("pointerover", handleSummaryPointerOver);
mapSummary?.addEventListener("pointerout", handleSummaryPointerOut);
document.querySelectorAll(".control-help-trigger").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.getAttribute("data-help-key");
    if (!key || !controlHelpText) {
      return;
    }
    controlHelpText.textContent = CONTROL_HELP_TEXT[key] || "No help is available for this control yet.";
  });
});
setupStepControlPanels();
setupScatterAlgorithmControls();

form.requestSubmit();

function setupStepControlPanels() {
  const stepItems = Array.from(document.querySelectorAll("#stepsList > li"));
  stepItems.forEach((item) => {
    const stepButton = item.querySelector(".step-select");
    const controls = item.querySelector(".step-controls");
    if (!stepButton || !controls) {
      return;
    }

    stepButton.addEventListener("click", () => {
      const willOpen = !item.classList.contains("step-controls-open");
      stepItems.forEach((other) => {
        other.classList.remove("step-controls-open");
      });
      if (willOpen) {
        item.classList.add("step-controls-open");
      }
    });
  });
}

function setupScatterAlgorithmControls() {
  const radios = Array.from(form.querySelectorAll('input[name="scatterAlgorithm"]'));
  const poissonPanel = document.querySelector("#poissonControlsPanel");
  if (!radios.length || !(poissonPanel instanceof HTMLElement)) {
    return;
  }

  const sync = () => {
    const selected = form.querySelector('input[name="scatterAlgorithm"]:checked');
    const usePoisson = selected instanceof HTMLInputElement && selected.value === "poisson_disk";
    poissonPanel.hidden = !usePoisson;
  };

  radios.forEach((radio) => {
    radio.addEventListener("change", sync);
  });
  sync();
}

/**
 * WHAT: Draw one generated step frame and synchronize the side-panel UI with it.
 * HOW: Clear or redraw the SVG, then select the matching generation step.
 * WHY: Step selection should update the viewport and step list as one consistent action.
 */
function renderStepIndex(stepIndex) {
  if (!currentMap) {
    clearSvg(svg, CANVAS_SIZE);
    applyViewport();
    updateMapSummary();
    return;
  }

  const frame = findFrameForStep(stepIndex);
  if (!frame) {
    return;
  }

  currentFrame = frame;
  drawReplayFrame(svg, frame, currentMap.meta.size);
  applyViewport();
  updateMapSummary(frame.map, currentMap);
  clearHoverState();
  stepTracker.setSelectedStep(frame.stepIndex ?? stepIndex);
}

function generateRandomSeed() {
  return Math.random().toString(36).slice(2, 10);
}

function runSingleGeneration(options) {
  const requestId = ++generationToken;
  cancelWorkerTask();
  stepTracker.reset();
  selectedStepIndex = GENERATION_STEPS.length - 1;
  setBackgroundTaskStatus(`Generating 0/${TOTAL_GENERATION_STEPS}`);
  setAsyncControlsDisabled(true);
  resetViewport(CANVAS_SIZE);
  clearHoverState();
  updateMapSummary(null, null);

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
      logStepParameters(message);
      setBackgroundTaskStatus(`Generating ${message.index + 1}/${TOTAL_GENERATION_STEPS}`);
      return;
    }

    if (message.type === "generation-step-complete") {
      stepTracker.finishStep(message.index, message.durationMs, message.status);
      renderInterimFrame(message.frame);
      setBackgroundTaskStatus(`Generating ${message.index + 1}/${TOTAL_GENERATION_STEPS}`);
      return;
    }

    if (message.type === "generation-step-progress") {
      renderInterimFrame(message.frame);
      const progressText = formatStepProgress(message.progress);
      setBackgroundTaskStatus(`Generating ${message.index + 1}/${TOTAL_GENERATION_STEPS}${progressText}`);
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

function logStepParameters(message) {
  if (!message || !message.params) {
    return;
  }

  console.log(`[generation] ${message.label}`, message.params);
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

function formatStepProgress(progress) {
  if (!progress || !Number.isFinite(progress.completed) || !Number.isFinite(progress.total) || progress.total <= 0) {
    return "";
  }
  return ` - lot ${progress.completed}/${progress.total}`;
}

function renderInterimFrame(frame) {
  if (!frame || frame.type !== "map") {
    return;
  }

  currentMap = null;
  currentFrame = frame;
  hoveredCellId = null;
  hoveredRiverId = null;
  drawReplayFrame(svg, frame, CANVAS_SIZE);
  applyViewport();
  updateMapSummary(frame.map, null);
  clearHoverState();
  stepTracker.setSelectedStep(frame.stepIndex ?? -1);
}

function renderBestCandidate(map) {
  if (!map) {
    return;
  }

  currentMap = map;
  stepTracker.setCompletedRun(map.stepDurations || []);
  renderStepIndex(selectedStepIndex);
}

function applyGeneratedMap(map) {
  currentMap = map;
  resetViewport(map.meta.size);
  renderStepIndex(selectedStepIndex);
}

function scheduleRegeneration() {
  window.clearTimeout(regenerateTimer);
  regenerateTimer = window.setTimeout(() => {
    form.requestSubmit();
  }, REGENERATE_DEBOUNCE_MS);
}

function findFrameForStep(stepIndex) {
  if (!currentMap || !Array.isArray(currentMap.frames)) {
    return null;
  }

  const exact = currentMap.frames.find((frame) => frame.stepIndex === stepIndex);
  if (exact) {
    return exact;
  }

  for (let index = currentMap.frames.length - 1; index >= 0; index -= 1) {
    const frame = currentMap.frames[index];
    if (frame?.type === "map") {
      return frame;
    }
  }
  return null;
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

function handleMapHover(event) {
  const river = getRiverFromEvent(event);
  if (river) {
    renderHoveredRiver(river);
    return;
  }

  const hoverTarget = getHoverTargetFromEvent(event);
  if (!hoverTarget) {
    clearHoverState();
    return;
  }

  renderHoveredGeometry(hoverTarget);
}

function clearHoverState() {
  if (!(hoveredCellData instanceof HTMLElement)) {
    return;
  }

  hoveredCellId = null;
  hoveredRiverId = null;
  clearFlowOverlay();
  clearNeighborOverlay();
  clearRiverOverlay();
  syncActiveRiverSummaryState();
  hoveredCellData.className = "cell-data empty";
  hoveredCellData.textContent = "Hover a lot or river to inspect its data.";
}

/**
 * WHAT: Zoom the SVG viewBox around a focus point while keeping the viewport inside map bounds.
 * HOW: Convert the desired zoom factor into a new viewBox rectangle anchored at the pointer or viewport center.
 * WHY: Users need precise inspection of dense maps without losing their place in the selected step view.
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
  mapViewport.classList.toggle("is-dragging", isDragging);
}

function updateMapSummary(frameMap = currentFrame?.map || null, completedMap = currentMap) {
  const geometries = frameMap ? getMapLots(frameMap) : [];
  const seaCount = geometries.filter((item) => item.features?.sea).length;
  const landCount = geometries.filter((item) => item.features?.land).length;
  const primaryRiver = frameMap?.rivers?.[0] || null;
  const tributaryRiver = frameMap?.rivers?.[1] || null;

  if (seaCellCount instanceof HTMLElement) {
    seaCellCount.textContent = String(seaCount);
  }
  if (landCellCount instanceof HTMLElement) {
    landCellCount.textContent = String(landCount);
  }
  if (generationTimeValue instanceof HTMLElement) {
    generationTimeValue.textContent = formatTotalGenerationTime(completedMap?.stepDurations || null);
  }

  syncRiverSummaryCard(primaryRiverSummary, primaryRiverLabel, primaryRiverLength, {
    label: primaryRiver?.name || "Primary river",
    length: primaryRiver?.length ?? null,
    riverId: primaryRiver?.id ?? null,
  });
  syncRiverSummaryCard(tributaryRiverSummary, tributaryRiverLabel, tributaryRiverLength, {
    label: tributaryRiver ? `${tributaryRiver.name || "Tributary"} -> ${primaryRiver?.name || "main"}` : "Tributary",
    length: tributaryRiver?.length ?? null,
    riverId: tributaryRiver?.id ?? null,
  });
  syncActiveRiverSummaryState();
}

function formatTotalGenerationTime(stepDurations) {
  if (!Array.isArray(stepDurations) || !stepDurations.length) {
    return "--";
  }

  const totalMs = stepDurations.reduce((sum, duration) => sum + (Number.isFinite(duration) ? duration : 0), 0);
  if (totalMs >= 1000) {
    return `${(totalMs / 1000).toFixed(2)} s`;
  }
  return `${Math.round(totalMs)} ms`;
}

function syncRiverSummaryCard(card, labelElement, valueElement, { label, length, riverId }) {
  if (!(card instanceof HTMLElement) || !(labelElement instanceof HTMLElement) || !(valueElement instanceof HTMLElement)) {
    return;
  }

  labelElement.textContent = label;
  valueElement.textContent = length === null || length === undefined ? "--" : formatDistanceMeters(length);
  if (riverId === null || riverId === undefined) {
    card.removeAttribute("data-summary-river-id");
  } else {
    card.setAttribute("data-summary-river-id", String(riverId));
  }
}

function syncActiveRiverSummaryState() {
  [primaryRiverSummary, tributaryRiverSummary].forEach((card) => {
    if (!(card instanceof HTMLElement)) {
      return;
    }

    const riverId = Number(card.getAttribute("data-summary-river-id"));
    const isActive = Number.isFinite(riverId) && riverId === hoveredRiverId;
    card.classList.toggle("is-active", isActive);
  });
}

function handleSummaryPointerOver(event) {
  const river = getRiverFromSummaryEvent(event);
  if (!river) {
    return;
  }

  renderHoveredRiver(river);
}

function handleSummaryPointerOut(event) {
  const currentCard = event.target instanceof Element ? event.target.closest("[data-summary-river-id]") : null;
  if (!currentCard) {
    return;
  }

  const relatedCard = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-summary-river-id]") : null;
  if (relatedCard === currentCard) {
    return;
  }

  clearHoverState();
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

function getHoverTargetFromEvent(event) {
  if (!currentFrame || currentFrame.type !== "map") {
    return null;
  }

  const target = event.target instanceof Element ? event.target.closest("[data-lot-id], [data-cell-id]") : null;
  const cellId = target
    ? Number(target.getAttribute("data-lot-id") || target.getAttribute("data-cell-id"))
    : Number.NaN;
  if (!Number.isFinite(cellId)) {
    return null;
  }

  const item = getMapLots(currentFrame.map).find((cell) => cell.id === cellId) || null;
  if (!item) {
    return null;
  }

  return {
    kind: Array.isArray(currentFrame.map.lots) ? "Lot" : "Cell",
    item,
  };
}

function getRiverFromEvent(event) {
  if (!currentFrame || currentFrame.type !== "map") {
    return null;
  }

  const target = event.target instanceof Element ? event.target.closest("[data-river-id]") : null;
  const riverId = target ? Number(target.getAttribute("data-river-id")) : Number.NaN;
  return getCurrentFrameRiverById(riverId);
}

function getRiverFromSummaryEvent(event) {
  if (!currentFrame || currentFrame.type !== "map") {
    return null;
  }

  const target = event.target instanceof Element ? event.target.closest("[data-summary-river-id]") : null;
  const riverId = target ? Number(target.getAttribute("data-summary-river-id")) : Number.NaN;
  return getCurrentFrameRiverById(riverId);
}

function getCurrentFrameRiverById(riverId) {
  if (!Number.isFinite(riverId)) {
    return null;
  }

  return currentFrame.map.rivers?.find((river) => river.id === riverId) || null;
}

function renderHoveredGeometry(hoverTarget) {
  if (!(hoveredCellData instanceof HTMLElement)) {
    return;
  }

  const { item, kind } = hoverTarget;
  hoveredCellId = item.id;
  hoveredRiverId = null;
  syncActiveRiverSummaryState();
  clearRiverOverlay();
  clearNeighborOverlay();
  const previewRiverPath = kind === "Cell" && shouldShowRiverPreview() ? computeCenterSeaFlowPath(item.id) : null;

  hoveredCellData.className = "cell-data";
  hoveredCellData.innerHTML = [
    createCellDataRow("Id", formatGeometryId(item, kind)),
    createCellDataRow("Features", formatFeatures(item.features)),
    createCellDataRow("Area", formatAreaSquareMeters(getGeometryArea(item))),
    createCellDataRow("Lots", formatContainedLotCount(item, kind)),
    createCellDataRow("Neighbours", formatNeighborList(item, kind)),
  ].join("");
  drawFlowOverlay(previewRiverPath);
}

function renderHoveredRiver(river) {
  if (!(hoveredCellData instanceof HTMLElement)) {
    return;
  }

  hoveredCellId = null;
  hoveredRiverId = river.id;
  clearFlowOverlay();
  clearNeighborOverlay();
  drawRiverOverlay(river);
  syncActiveRiverSummaryState();

  hoveredCellData.className = "cell-data river-hover";
  hoveredCellData.innerHTML = [
    createCellDataRow("River", river.name || `River ${river.id}`),
    createCellDataRow("Id", String(river.id)),
    createCellDataRow("Length", formatDistanceMeters(river.length)),
    createCellDataRow("Cells", String(river.cellIds?.length || 0)),
    createCellDataRow("Width", formatRiverWidth(river)),
    createCellDataRow("Source Cell", river.sourceCellId ?? "n/a"),
    createCellDataRow("Merge Cell", river.mergeCellId ?? river.widthMergeCellId ?? "n/a"),
    createCellDataRow("Target Sea Cell", river.targetSeaCellId ?? "n/a"),
    createCellDataRow("Branch", describeRiverBranch(river)),
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

function drawNeighborOverlay(cell, kind = null) {
  clearNeighborOverlay();
  const neighbors = getNeighborRefs(cell, kind);
  if (!neighbors.length) {
    return;
  }

  const lots = getMapLots(currentFrame?.map || {});
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", HOVER_NEIGHBOR_OVERLAY_ID);
  overlay.setAttribute("pointer-events", "none");

  const origin = cell.centroid;
  neighbors.forEach((neighborRef) => {
    const neighbor = lots.find((lot) => lot.id === neighborRef.id);
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

function drawRiverOverlay(river) {
  clearRiverOverlay();
  if (!river?.points || river.points.length < 2) {
    return;
  }

  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", HOVER_RIVER_OVERLAY_ID);
  overlay.setAttribute("pointer-events", "none");

  const glow = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  glow.setAttribute("points", toSvgPoints(river.points));
  glow.setAttribute("fill", "none");
  glow.setAttribute("stroke", RIVER_HOVER_GLOW);
  glow.setAttribute("stroke-width", String((river.strokeWidthAfterMerge ?? river.strokeWidth ?? 18) + 9));
  glow.setAttribute("stroke-linecap", "round");
  glow.setAttribute("stroke-linejoin", "round");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", toSvgPoints(river.points));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", RIVER_HOVER_STROKE);
  line.setAttribute("stroke-width", String((river.strokeWidthAfterMerge ?? river.strokeWidth ?? 18) + 3));
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");

  overlay.append(glow, line);
  svg.append(overlay);
}

function clearRiverOverlay() {
  svg.querySelector(`#${HOVER_RIVER_OVERLAY_ID}`)?.remove();
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

function getNeighborRefs(item, kind) {
  if (!item) {
    return [];
  }

  const type = kind === "Cell" ? "cell" : "lot";
  return getNeighborIds(item).map((id) => ({ type, id }));
}

function formatGeometryId(item, kind) {
  return `${kind} ${item.id}`;
}

function formatContainedLotCount(item, kind) {
  if (kind !== "Lot") {
    return "n/a";
  }

  const sublotCount = getSublots(currentFrame?.map || {}).filter((sublot) => sublot.lotId === item.id).length;
  return String(sublotCount || 1);
}

function formatNeighborList(item, kind) {
  const neighborRefs = getNeighborRefs(item, kind);
  if (!neighborRefs.length) {
    return "none";
  }

  return neighborRefs
    .map((neighborRef) => `${kind} ${neighborRef.id}`)
    .join(", ");
}

function getSublots(map) {
  return map?.tessellation?.sublots || [];
}

function formatFeatures(features = {}) {
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ") || "none";
}

function formatDistanceMeters(value) {
  return `${value.toFixed(1)} m`;
}

function formatAreaSquareMeters(value) {
  return `${value.toFixed(0)} m2`;
}

function getGeometryArea(geometry) {
  if (Number.isFinite(geometry.area)) {
    return geometry.area;
  }
  return computePolygonArea(geometry.polygon || []);
}

function computePolygonArea(polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
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
  outline.setAttribute("stroke-width", String(FLOW_STROKE_WIDTH + 6));
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

function formatRiverWidth(river) {
  const before = river.strokeWidthBeforeMerge ?? river.strokeWidth ?? 0;
  const after = river.strokeWidthAfterMerge ?? river.strokeWidth ?? before;
  return before === after ? formatDistanceMeters(before) : `${formatDistanceMeters(before)} -> ${formatDistanceMeters(after)}`;
}

function describeRiverBranch(river) {
  if (river.mergedIntoRiverId !== undefined) {
    return `tributary of ${river.mergedIntoRiverId}`;
  }
  if (river.widthMergeCellId !== null && river.widthMergeCellId !== undefined) {
    return "primary with downstream merge gain";
  }
  return "primary";
}
