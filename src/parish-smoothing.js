/*
 * WHAT: Drive the standalone parish-border smoothing tutorial page.
 * HOW: Load one deterministic generated map and render the production parish-smoothing trace frames.
 * WHY: The step 2.4 smoothing pass should be inspectable without the full main-map UI.
 */

import { buildParishSmoothingTutorialTrace } from "./generator/parish-smoothing-trace.js";
import { getParishSmoothingDemoDataset } from "./tutorial-demo-data.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const previousButton = document.querySelector("#previousStepButton");
const nextButton = document.querySelector("#nextStepButton");
const stepCounter = document.querySelector("#stepCounter");
const stepTitle = document.querySelector("#stepTitle");
const stepBody = document.querySelector("#stepBody");
const datasetKicker = document.querySelector("#datasetKicker");
const svg = document.querySelector("#parishSvg");

let trace = null;
let stepIndex = 0;

previousButton.addEventListener("click", () => {
  if (!trace) {
    return;
  }
  stepIndex = Math.max(0, stepIndex - 1);
  render();
});
nextButton.addEventListener("click", () => {
  if (!trace) {
    return;
  }
  stepIndex = Math.min(trace.frames.length - 1, stepIndex + 1);
  render();
});

init();

async function init() {
  trace = buildParishSmoothingTutorialTrace(await getParishSmoothingDemoDataset());
  render();
}

function render() {
  const current = trace.frames[stepIndex];
  datasetKicker.textContent = trace.dataset.name;
  stepTitle.textContent = current.title;
  stepBody.textContent = current.body;
  stepCounter.textContent = `${stepIndex + 1} / ${trace.frames.length}`;
  previousButton.disabled = stepIndex === 0;
  nextButton.disabled = stepIndex >= trace.frames.length - 1;
  drawFrame(current.geometry);
}

function drawFrame(geometry) {
  svg.replaceChildren();
  const size = trace.dataset.size;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

  const layer = createElement("g", { class: "tutorial-svg-layer" });
  layer.append(createElement("rect", {
    class: "parish-map-background",
    x: 0,
    y: 0,
    width: size,
    height: size,
  }));
  (geometry.lots || []).forEach((lot) => {
    layer.append(createElement("polygon", {
      class: "parish-lot",
      points: toSvgPoints(lot.polygon),
      fill: parishFill(lot),
    }));
  });
  (geometry.segments || []).forEach((segment) => {
    layer.append(createLine(segment.from, segment.to, segment.className || "parish-muted-edge"));
  });
  (geometry.curves || []).forEach((curve) => {
    layer.append(createElement("polyline", {
      class: curve.className || "parish-bezier-guide",
      points: toSvgPoints(curve.points),
    }));
  });
  (geometry.points || []).forEach((item) => {
    layer.append(createPoint(item));
  });
  svg.append(layer);
}

function parishFill(lot) {
  const palette = [
    "rgba(209, 133, 92, 0.48)",
    "rgba(83, 141, 195, 0.44)",
    "rgba(119, 164, 121, 0.44)",
  ];
  if (lot.parishId === null || lot.parishId === undefined) {
    return "rgba(197, 220, 206, 0.72)";
  }
  return palette[lot.parishId % palette.length];
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
    r: label ? 9 : 6,
  }));
  if (label !== undefined) {
    const text = createElement("text", {
      x: point.x,
      y: point.y - 14,
      "text-anchor": "middle",
    });
    text.textContent = label;
    group.append(text);
  }
  return group;
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
