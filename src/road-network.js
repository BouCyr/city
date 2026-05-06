/*
 * WHAT: Drive the standalone road-network tutorial page.
 * HOW: Load one deterministic generated parish map and render the production road-network trace frames.
 * WHY: Road selection should be inspectable one linked parish at a time.
 */

import { buildRoadNetworkTutorialTrace } from "./generator/road-network-trace.js";
import { getRoadNetworkDemoDataset } from "./tutorial-demo-data.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const previousButton = document.querySelector("#previousStepButton");
const nextButton = document.querySelector("#nextStepButton");
const stepCounter = document.querySelector("#stepCounter");
const stepTitle = document.querySelector("#stepTitle");
const stepBody = document.querySelector("#stepBody");
const datasetKicker = document.querySelector("#datasetKicker");
const svg = document.querySelector("#roadNetworkSvg");

let trace = null;
let stepIndex = 0;

previousButton.addEventListener("click", () => {
  if (!trace) return;
  stepIndex = Math.max(0, stepIndex - 1);
  render();
});

nextButton.addEventListener("click", () => {
  if (!trace) return;
  stepIndex = Math.min(trace.frames.length - 1, stepIndex + 1);
  render();
});

init();

async function init() {
  trace = buildRoadNetworkTutorialTrace(await getRoadNetworkDemoDataset());
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
    class: "road-network-map-background",
    x: 0,
    y: 0,
    width: size,
    height: size,
  }));

  (geometry.lots || []).forEach((lot) => {
    layer.append(createElement("polygon", {
      class: "road-network-lot",
      points: toSvgPoints(lot.polygon),
      fill: parishFill(lot),
    }));
  });

  const nodesById = new Map((geometry.routeGraph?.nodes || []).map((node) => [node.id, node]));
  const currentRouteIds = new Set(geometry.currentRouteIds || []);
  const roadRouteIds = new Set(geometry.roadRouteIds || []);
  (geometry.routeGraph?.routes || [])
    .filter((route) => route.type === "road" || route.type === "street" || route.type === "alley")
    .forEach((route) => {
      const from = nodesById.get(route.fromNodeId);
      const to = nodesById.get(route.toNodeId);
      if (!from || !to) return;
      const className = currentRouteIds.has(route.id)
        ? "road-network-current-road"
        : roadRouteIds.has(route.id) || route.type === "street"
          ? "road-network-road"
          : route.features?.roadNetworkCenterAlley
            ? "road-network-center-alley"
            : "road-network-alley";
      layer.append(createLine(from, to, className));
    });

  const bridgeNodeIds = new Set(geometry.bridgeNodeIds || []);
  bridgeNodeIds.forEach((nodeId) => {
    const node = nodesById.get(nodeId);
    if (node) {
      layer.append(createPoint(node, "road-network-bridge-node"));
    }
  });

  const linkedParishIds = new Set(geometry.linkedParishIds || []);
  (geometry.parishCenters || []).forEach((center) => {
    const className = center.parishId === geometry.centerParishId
      ? "road-network-center-node"
      : center.parishId === geometry.targetParishId
        ? "road-network-target-node"
        : linkedParishIds.has(center.parishId)
          ? "road-network-linked-node"
          : "road-network-parish-node";
    layer.append(createLabeledPoint(center, center.letter || center.parishId, className));
  });

  svg.append(layer);
}

function parishFill(lot) {
  const palette = [
    "rgba(209, 133, 92, 0.48)",
    "rgba(83, 141, 195, 0.44)",
    "rgba(119, 164, 121, 0.44)",
  ];
  return lot.parishId === null || lot.parishId === undefined
    ? "rgba(197, 220, 206, 0.72)"
    : palette[lot.parishId % palette.length];
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

function createPoint(point, className) {
  return createElement("circle", {
    class: className,
    cx: point.x,
    cy: point.y,
    r: 7,
  });
}

function createLabeledPoint(point, label, className) {
  const group = createElement("g", { class: className });
  group.append(createElement("circle", {
    cx: point.x,
    cy: point.y,
    r: 12,
  }));
  const text = createElement("text", {
    x: point.x,
    y: point.y + 5,
    "text-anchor": "middle",
  });
  text.textContent = label;
  group.append(text);
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
