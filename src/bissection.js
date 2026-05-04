/*
 * WHAT: Drive the standalone bisection tutorial page.
 * HOW: Build trace frames from the shared step 2.1 trace helper and render the selected frame into SVG.
 * WHY: The page explains the actual tessellation algorithms without depending on the full map UI.
 */

import { buildBisectionTutorialTrace, TUTORIAL_LOT, TUTORIAL_LOTS } from "./generator/2-1-tessellate-lots/2-1-bisection-trace.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX_PADDING = 80;

const algorithmSelect = document.querySelector("#algorithmSelect");
const lotSelect = document.querySelector("#lotSelect");
const previousButton = document.querySelector("#previousStepButton");
const nextButton = document.querySelector("#nextStepButton");
const stepCounter = document.querySelector("#stepCounter");
const stepTitle = document.querySelector("#stepTitle");
const stepBody = document.querySelector("#stepBody");
const lotKicker = document.querySelector("#lotKicker");
const svg = document.querySelector("#bissectionSvg");

let trace = null;
let stepIndex = 0;
let selectedLot = TUTORIAL_LOT;

algorithmSelect.addEventListener("change", () => {
  rebuildTrace();
});
lotSelect.addEventListener("change", () => {
  selectedLot = TUTORIAL_LOTS[lotSelect.value] || TUTORIAL_LOT;
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
  trace = buildBisectionTutorialTrace({
    algorithm: algorithmSelect.value,
    lot: selectedLot,
  });
  stepIndex = 0;
  render();
}

function render() {
  const current = trace.frames[stepIndex];
  if (lotKicker instanceof HTMLElement) {
    lotKicker.textContent = `${selectedLot.name || "Lot"} / Lot #${selectedLot.id}`;
  }
  stepTitle.textContent = current.title;
  stepBody.textContent = current.body;
  stepCounter.textContent = `${stepIndex + 1} / ${trace.frames.length}`;
  previousButton.disabled = stepIndex === 0;
  nextButton.disabled = stepIndex >= trace.frames.length - 1;
  drawFrame(current.geometry);
}

function drawFrame(geometry) {
  svg.replaceChildren();
  const bbox = computeBounds(selectedLot.polygon);
  svg.setAttribute("viewBox", `${bbox.minX - VIEWBOX_PADDING} ${bbox.minY - VIEWBOX_PADDING} ${bbox.width + (VIEWBOX_PADDING * 2)} ${bbox.height + (VIEWBOX_PADDING * 2)}`);

  const layer = createElement("g", { class: "tutorial-svg-layer" });
  const basePolygon = geometry.basePolygon || selectedLot.polygon;
  layer.append(createElement("polygon", {
    class: "tutorial-base-lot",
    points: toSvgPoints(basePolygon),
  }));
  (geometry.partition || []).forEach((polygon) => {
    layer.append(createElement("polygon", {
      class: polygon.className,
      points: toSvgPoints(polygon.points),
    }));
  });
  if (geometry.activePolygon) {
    layer.append(createElement("polygon", {
      class: "tutorial-active-highlight",
      points: toSvgPoints(geometry.activePolygon),
    }));
  }
  (geometry.polygons || []).forEach((polygon) => {
    layer.append(createElement("polygon", {
      class: polygon.className,
      points: toSvgPoints(polygon.points),
    }));
  });
  (geometry.candidateLines || []).forEach((line) => {
    layer.append(createLine(line.from, line.to, line.className));
  });
  if (geometry.selectedLine) {
    layer.append(createLine(geometry.selectedLine.from, geometry.selectedLine.to, geometry.selectedLine.className));
  }
  (geometry.normals || []).forEach((line) => {
    layer.append(createLine(line.from, line.to, line.className));
  });
  if (geometry.circle) {
    layer.append(createElement("circle", {
      class: "tutorial-tangent-circle",
      cx: geometry.circle.center.x,
      cy: geometry.circle.center.y,
      r: geometry.circle.radius,
    }));
    layer.append(createElement("circle", {
      class: "tutorial-circle-center",
      cx: geometry.circle.center.x,
      cy: geometry.circle.center.y,
      r: 5,
    }));
  }
  if (geometry.splitPath?.length > 1) {
    layer.append(createElement("polyline", {
      class: "tutorial-split-path",
      points: toSvgPoints(geometry.splitPath),
    }));
  }
  (geometry.points || []).forEach((item) => {
    layer.append(createPoint(item));
  });
  svg.append(layer);
}

function createLine(from, to, className) {
  return createElement("line", {
    class: className || "tutorial-line",
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
    r: 9,
  }));
  if (label !== undefined) {
    const text = createElement("text", {
      x: point.x,
      y: point.y - 15,
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
