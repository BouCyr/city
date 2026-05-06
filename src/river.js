/*
 * WHAT: Drive the standalone river smoothing tutorial page.
 * HOW: Load one deterministic generated map and render trace frames from the production river smoothing helpers.
 * WHY: River smoothing should be inspectable without diverging from the main generator.
 */

import { buildRiverTutorialTrace } from "./generator/river-smoothing-trace.js";
import { getRiverDemoDataset } from "./tutorial-demo-data.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const previousButton = document.querySelector("#previousStepButton");
const nextButton = document.querySelector("#nextStepButton");
const stepCounter = document.querySelector("#stepCounter");
const stepTitle = document.querySelector("#stepTitle");
const stepBody = document.querySelector("#stepBody");
const datasetKicker = document.querySelector("#datasetKicker");
const svg = document.querySelector("#riverSvg");

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
  trace = buildRiverTutorialTrace(await getRiverDemoDataset());
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
    class: "river-map-background",
    x: 0,
    y: 0,
    width: size,
    height: size,
  }));
  (geometry.lots || []).forEach((lot) => {
    layer.append(createElement("polygon", {
      class: lot.features?.sea ? "coastline-final-sea-lot" : "river-land-cell",
      points: toSvgPoints(lot.polygon),
    }));
  });
  (geometry.cells || []).forEach((cell) => {
    layer.append(createElement("polygon", {
      class: "river-land-cell",
      points: toSvgPoints(cell.polygon),
    }));
  });
  (geometry.edges || []).forEach((edge) => {
    layer.append(createLine(edge.from, edge.to, edge.className || "river-grid-edge"));
  });
  (geometry.rawPaths || []).forEach((path) => {
    layer.append(createElement("polyline", {
      class: path.className || "river-raw-path",
      points: toSvgPoints(path.points),
    }));
  });
  (geometry.curves || []).forEach((curve) => {
    layer.append(createElement("polyline", {
      class: curve.className || "river-bezier-guide",
      points: toSvgPoints(curve.points),
    }));
  });
  (geometry.segments || []).forEach((segment) => {
    layer.append(createLine(segment.from, segment.to, segment.className || "river-final-segment"));
  });
  (geometry.segmentsOverlay || []).forEach((segment) => {
    layer.append(createLine(segment.from, segment.to, segment.className || "river-final-segment"));
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
