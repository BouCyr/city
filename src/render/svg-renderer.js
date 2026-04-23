/*
 * WHAT: Render the current replay frame into an inline SVG map view.
 * HOW: Rebuild SVG groups for the background, cells, edges, rivers, and fallback points each time a frame changes.
 * WHY: SVG keeps the map crisp at any zoom level and matches the viewport controls used by the UI.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_DIVISIONS = 12;
const EDGE_STROKE_WIDTH = 1.2;
const DEFAULT_RIVER_STROKE_WIDTH = 2.8;
const COLORS = {
  background: "#f5f2ea",
  grid: "rgba(24, 33, 38, 0.06)",
  landFill: "#f1eadb",
  centerFill: "#efc8c3",
  point: "#d6693c",
  edge: "#1a2026",
  seaFill: "#7ebbd4",
  seaEdge: "#1f4e72",
  river: "#2a8fff",
};

/**
 * WHAT: Reset the SVG back to the empty background grid for the provided map size.
 * HOW: Replace all children, restore the default viewBox, and append the reusable base layer.
 * WHY: Blank and replay-reset states should look deliberate rather than leaving stale geometry behind.
 */
export function clearSvg(svg, size) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.append(createBaseLayer(size));
}

/**
 * WHAT: Draw the requested replay frame or clear the map when the frame is blank.
 * HOW: Delegate to the main city-map renderer for populated frames and fall back to the base grid otherwise.
 * WHY: Replay controls should not need to know anything about SVG structure.
 */
export function drawReplayFrame(svg, frame, size) {
  if (!frame || frame.type === "blank") {
    clearSvg(svg, size);
    return;
  }

  drawCityMap(svg, frame.map, size);
}

/**
 * WHAT: Render one full map state into the SVG viewport.
 * HOW: Clear the base layer, then append grouped SVG primitives for every visible map feature.
 * WHY: The renderer should accept plain generator data and stay stateless between frames.
 */
export function drawCityMap(svg, map, fallbackSize = map.meta?.size) {
  const size = map.meta?.size || fallbackSize;
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

  for (let offset = 0; offset <= size; offset += size / GRID_DIVISIONS) {
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
  layer.append(createCellsGroup(map.cells), createEdgesGroup(map.edges), createRiversGroup(map.rivers || []));

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
        fill: cell.features.sea ? COLORS.seaFill : cell.features.cityCenter ? COLORS.centerFill : COLORS.landFill,
      }),
    );
  });

  return group;
}

function createEdgesGroup(edges) {
  const group = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
    "stroke-width": EDGE_STROKE_WIDTH,
  });

  edges.forEach((edge) => {
    group.append(
      createElement("line", {
        x1: edge.from.x,
        y1: edge.from.y,
        x2: edge.to.x,
        y2: edge.to.y,
        stroke: edge.features.sea ? COLORS.seaEdge : COLORS.edge,
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

function createRiversGroup(rivers) {
  const group = createElement("g", {
    fill: "none",
    stroke: COLORS.river,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });

  rivers.forEach((river) => {
    river.segments.forEach((segment) => {
      group.append(
        createElement("line", {
          x1: segment.from.x,
          y1: segment.from.y,
          x2: segment.to.x,
          y2: segment.to.y,
          "stroke-width": segment.width || DEFAULT_RIVER_STROKE_WIDTH,
        }),
      );
    });
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
