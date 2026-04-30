/*
 * WHAT: Drive the standalone coastline tutorial page.
 * HOW: Render frames from the same coastline trace builder used by step 1.9.
 * WHY: The smoothing step should be inspectable without running a full random map.
 */

import {
  COASTLINE_TUTORIAL_DATASETS,
  DEFAULT_COASTLINE_DATASET,
  buildCoastlineTutorialTrace,
} from "./generator/1-9-build-coastline-geometry/1-9-coastline-trace.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX_PADDING = 70;

const datasetSelect = document.querySelector("#datasetSelect");
const previousButton = document.querySelector("#previousStepButton");
const nextButton = document.querySelector("#nextStepButton");
const stepCounter = document.querySelector("#stepCounter");
const stepTitle = document.querySelector("#stepTitle");
const stepBody = document.querySelector("#stepBody");
const datasetKicker = document.querySelector("#datasetKicker");
const svg = document.querySelector("#coastlineSvg");

let selectedDataset = DEFAULT_COASTLINE_DATASET;
let trace = null;
let stepIndex = 0;

datasetSelect.addEventListener("change", () => {
  selectedDataset = COASTLINE_TUTORIAL_DATASETS[datasetSelect.value] || DEFAULT_COASTLINE_DATASET;
  rebuildTrace();
});
previousButton.addEventListener("click", () => {
  stepIndex = Math.max(0, stepIndex - 1);
  render();
});
nextButton.addEventListener("click", () => {
  stepIndex = Math.min(trace.frames.length - 1, stepIndex + 1);
  render();
});

rebuildTrace();

function rebuildTrace() {
  trace = buildCoastlineTutorialTrace(selectedDataset);
  stepIndex = 0;
  render();
}

function render() {
  const current = trace.frames[stepIndex];
  datasetKicker.textContent = selectedDataset.name;
  stepTitle.textContent = current.title;
  stepBody.textContent = current.body;
  stepCounter.textContent = `${stepIndex + 1} / ${trace.frames.length}`;
  previousButton.disabled = stepIndex === 0;
  nextButton.disabled = stepIndex >= trace.frames.length - 1;
  drawFrame(current.geometry);
}

function drawFrame(geometry) {
  svg.replaceChildren();
  const bounds = computeBounds([
    ...selectedDataset.cells.flatMap((cell) => cell.polygon),
    ...selectedDataset.edges.flatMap((edge) => [edge.from, edge.to]),
  ]);
  svg.setAttribute("viewBox", `${bounds.minX - VIEWBOX_PADDING} ${bounds.minY - VIEWBOX_PADDING} ${bounds.width + (VIEWBOX_PADDING * 2)} ${bounds.height + (VIEWBOX_PADDING * 2)}`);

  const layer = createElement("g", { class: "tutorial-svg-layer" });
  (geometry.cells || []).forEach((cell) => {
    layer.append(createElement("polygon", {
      class: cell.features.sea ? "coastline-sea-cell" : "coastline-land-cell",
      points: toSvgPoints(cell.polygon),
    }));
  });
  (geometry.edges || []).forEach((edge) => {
    layer.append(createLine(edge.from, edge.to, edge.className || "coastline-raw-edge"));
  });
  (geometry.curves || []).forEach((curve) => {
    layer.append(createElement("polyline", {
      class: curve.className || "coastline-bezier-guide",
      points: toSvgPoints(curve.points),
    }));
  });
  (geometry.points || []).forEach((item) => {
    layer.append(createPoint(item));
  });
  svg.append(layer);
}

function createLine(from, to, className) {
  return createElement("line", {
    class: className,
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
  });
}

function createPoint({ point, label, className }) {
  const group = createElement("g", { class: `tutorial-point ${className || ""}`.trim() });
  group.append(createElement("circle", {
    cx: point.x,
    cy: point.y,
    r: label ? 10 : 5,
  }));
  if (label !== undefined) {
    const text = createElement("text", {
      x: point.x,
      y: point.y - 16,
      "text-anchor": "middle",
    });
    text.textContent = label;
    group.append(text);
  }
  return group;
}

function computeBounds(points) {
  const bounds = points.reduce((result, point) => ({
    minX: Math.min(result.minX, point.x),
    minY: Math.min(result.minY, point.y),
    maxX: Math.max(result.maxX, point.x),
    maxY: Math.max(result.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return {
    ...bounds,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
  };
}

function createElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });
  return element;
}

function toSvgPoints(points) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}
