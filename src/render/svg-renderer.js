const SVG_NS = "http://www.w3.org/2000/svg";
const COLORS = {
  background: "#f5f2ea",
  grid: "rgba(24, 33, 38, 0.06)",
  landFill: "#f1eadb",
  centerFill: "#efc8c3",
  point: "#d6693c",
  edge: "#1a2026",
  seaFill: "#7ebbd4",
  seaEdge: "#1f4e72",
};

export function clearSvg(svg, size) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.append(createBaseLayer(size));
}

export function drawReplayFrame(svg, frame, size) {
  if (!frame || frame.type === "blank") {
    clearSvg(svg, size);
    return;
  }

  drawCityMap(svg, frame.map, size);
}

export function drawCityMap(svg, map, fallbackSize = map.size) {
  const size = map.size || fallbackSize;
  clearSvg(svg, size);
  svg.append(createMapLayer(map));
}

function createBaseLayer(size) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    createElement("rect", {
      x: 0,
      y: 0,
      width: size,
      height: size,
      fill: COLORS.background,
    }),
    createGrid(size),
  );
  return fragment;
}

function createGrid(size) {
  const group = createElement("g", {
    "stroke-width": 1,
    stroke: COLORS.grid,
    "aria-hidden": "true",
  });

  for (let offset = 0; offset <= size; offset += size / 12) {
    group.append(
      createElement("line", {
        x1: offset,
        y1: 0,
        x2: offset,
        y2: size,
      }),
      createElement("line", {
        x1: 0,
        y1: offset,
        x2: size,
        y2: offset,
      }),
    );
  }

  return group;
}

function createMapLayer(map) {
  const layer = createElement("g");
  layer.append(createCellsGroup(map.cells), createEdgesGroup(map.edges));

  if (!map.cells.length) {
    layer.append(createPointsGroup(map.points));
  }

  return layer;
}

function createCellsGroup(cells) {
  const group = createElement("g");

  cells.forEach((cell) => {
    if (cell.polygon.length < 3) {
      return;
    }

    group.append(
      createElement("polygon", {
        points: toSvgPoints(cell.polygon),
        fill: cell.isSea ? COLORS.seaFill : cell.isCityCenter ? COLORS.centerFill : COLORS.landFill,
      }),
    );
  });

  return group;
}

function createEdgesGroup(edges) {
  const group = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
    "stroke-width": 1.2,
  });

  edges.forEach((edge) => {
    group.append(
      createElement("line", {
        x1: edge.from.x,
        y1: edge.from.y,
        x2: edge.to.x,
        y2: edge.to.y,
        stroke: edge.kind === "sea" ? COLORS.seaEdge : COLORS.edge,
      }),
    );
  });

  return group;
}

function createPointsGroup(points) {
  const group = createElement("g");

  points.forEach((point) => {
    group.append(
      createElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 1.8,
        fill: COLORS.point,
      }),
    );
  });

  return group;
}

function toSvgPoints(points) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function createElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });

  return element;
}
