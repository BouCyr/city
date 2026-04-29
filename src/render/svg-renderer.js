/*
 * WHAT: Render the current replay frame into an inline SVG map view.
 * HOW: Rebuild SVG groups for the background, lots, canonical segments, rivers, and fallback points each time a frame changes.
 * WHY: SVG keeps the map crisp at any zoom level and matches the viewport controls used by the UI.
 */

import { getMapGeometry } from "../generator/map-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_DIVISIONS = 12;
const EDGE_STROKE_WIDTH = 2.55;
const SEGMENT_ENDPOINT_RADIUS = 3.0;
const RIVER_ENDPOINT_RADIUS = 7.05;
const COLORS = {
  background: "#f5f2ea",
  grid: "rgba(24, 33, 38, 0.06)",
  landFill: "#c8ae89",
  hillsideFill: "#b89263",
  hillFill: "#9b774e",
  centerFill: "#efc8c3",
  point: "#d6693c",
  edge: "#1a2026",
  seaFill: "#7ebbd4",
  seaEdge: "#1f4e72",
  riverEndpoint: "#5f97b0",
  riverHit: "rgba(0, 0, 0, 0)",
  tessellation: "rgba(42, 30, 20, 0.36)",
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
    "stroke-width": 3,
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
  const { lots, segments } = getMapGeometry(map);
  const layer = createElement("g");
  layer.append(
    createLotsGroup(lots),
    createSegmentsGroup(segments),
    createTessellationGroup(map.tessellation),
    createRiversGroup(map.rivers || [], segments),
  );

  if (!lots.length) {
    layer.append(createPointsGroup(map.points));
  }

  return layer;
}

function createLotsGroup(lots) {
  const group = createElement("g");

  lots.forEach((lot) => {
    if (lot.polygon.length < 3) {
      return;
    }

    group.append(
      createElement("polygon", {
        points: toSvgPoints(lot.polygon),
        fill: lot.features.sea
          ? COLORS.seaFill
          : lot.features.hill
            ? COLORS.hillFill
            : lot.features.hillside
              ? COLORS.hillsideFill
              : lot.features.cityCenter
                ? COLORS.centerFill
                : COLORS.landFill,
        "data-lot-id": lot.id,
        "data-cell-id": lot.id,
      }),
    );
  });

  return group;
}

function createSegmentsGroup(segments) {
  const group = createElement("g", {
    "pointer-events": "none",
  });
  const lineGroup = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
    "stroke-width": EDGE_STROKE_WIDTH,
  });
  const dotGroup = createElement("g");

  segments.forEach((segment) => {
    const leftId = segment.leftLotId ?? segment.leftCellId ?? "";
    const rightId = segment.rightLotId ?? segment.rightCellId ?? "";
    const stroke = segment.features.river
      ? COLORS.seaFill
      : segment.features.sea
        ? COLORS.seaEdge
        : COLORS.edge;

    lineGroup.append(
      createElement("line", {
        x1: segment.from.x,
        y1: segment.from.y,
        x2: segment.to.x,
        y2: segment.to.y,
        stroke,
        "data-segment-id": segment.id,
        "data-edge-id": segment.id,
        "data-left-lot-id": leftId,
        "data-right-lot-id": rightId,
        "data-left-cell-id": leftId,
        "data-right-cell-id": rightId,
      }),
    );

    dotGroup.append(
      createElement("circle", {
        cx: segment.from.x,
        cy: segment.from.y,
        r: SEGMENT_ENDPOINT_RADIUS,
        fill: stroke,
      }),
      createElement("circle", {
        cx: segment.to.x,
        cy: segment.to.y,
        r: SEGMENT_ENDPOINT_RADIUS,
        fill: stroke,
      }),
    );
  });
  group.append(lineGroup, dotGroup);
  return group;
}

function createTessellationGroup(tessellation) {
  const group = createElement("g");

  if (!tessellation?.vertices?.length || !tessellation?.sublots?.length) {
    return group;
  }

  const vertices = new Map(tessellation.vertices.map((vertex) => [vertex.id, vertex]));
  const edges = new Map();
  const hitGroup = createElement("g", {
    fill: "rgba(0, 0, 0, 0)",
    stroke: "none",
    "pointer-events": "all",
  });
  const lineGroup = createElement("g", {
    fill: "none",
    stroke: COLORS.tessellation,
    "stroke-width": 0.45,
    "pointer-events": "none",
  });

  tessellation.sublots.forEach((sublot) => {
    const points = sublot.vertexIds.map((vertexId) => vertices.get(vertexId)).filter(Boolean);
    if (points.length >= 3) {
      hitGroup.append(
        createElement("polygon", {
          points: toSvgPoints(points),
          "data-sublot-id": sublot.id,
          "data-lot-id": sublot.lotId,
        }),
      );
    }

    const sourceKey = `${sublot.lotId}:${sublot.siteIndex ?? sublot.id}`;
    for (let index = 0; index < points.length; index += 1) {
      const from = points[index];
      const to = points[(index + 1) % points.length];
      const key = tessellationEdgeKey(from, to);
      const edge = edges.get(key) || {
        from,
        to,
        sourceKeys: new Set(),
        occurrences: 0,
      };
      edge.sourceKeys.add(sourceKey);
      edge.occurrences += 1;
      edges.set(key, edge);
    }
  });

  edges.forEach((edge) => {
    if (edge.occurrences > 1 && edge.sourceKeys.size === 1) {
      return;
    }
    lineGroup.append(
      createElement("line", {
        x1: edge.from.x,
        y1: edge.from.y,
        x2: edge.to.x,
        y2: edge.to.y,
      }),
    );
  });
  group.append(hitGroup, lineGroup, createTessellationVerticesGroup(tessellation.vertices));

  return group;
}

function createTessellationVerticesGroup(vertices) {
  const group = createElement("g", {
    "pointer-events": "none",
  });

  vertices.forEach((vertex) => {
    group.append(
      createElement("circle", {
        cx: vertex.x,
        cy: vertex.y,
        r: 2.25,
        fill: COLORS.tessellation,
      }),
    );
  });

  return group;
}

function tessellationEdgeKey(first, second) {
  const firstKey = `${first.x.toFixed(4)},${first.y.toFixed(4)}`;
  const secondKey = `${second.x.toFixed(4)},${second.y.toFixed(4)}`;
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

function createPointsGroup(points) {
  const group = createElement("g", {
    "pointer-events": "none",
  });

  points.forEach((point) => {
    group.append(
      createElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 5.4,
        fill: COLORS.point,
      }),
    );
  });

  return group;
}

function createRiversGroup(rivers, segments) {
  const group = createElement("g", {
    fill: "none",
  });

  rivers.forEach((river) => {
    if (!river.points || river.points.length < 2) {
      return;
    }

    group.append(
      ...createRiverStrokes(river),
    );
  });

  const endpointGroup = createRiverEndpointGroup(segments);
  if (endpointGroup) {
    group.append(endpointGroup);
  }

  return group;
}

function createRiverStrokes(river) {
  const widthBeforeMerge = river.strokeWidthBeforeMerge ?? river.strokeWidth ?? 18;
  const widthAfterMerge = river.strokeWidthAfterMerge ?? river.strokeWidth ?? widthBeforeMerge;
  const mergePointIndex = findRiverMergePointIndex(river);

  if (mergePointIndex === null || mergePointIndex <= 0 || mergePointIndex >= river.points.length - 1 || widthBeforeMerge === widthAfterMerge) {
    return [
      createRiverHitStroke(river.id, river.points, widthBeforeMerge),
      createRiverStroke(river.id, river.points, widthBeforeMerge),
    ];
  }

  const upstreamPoints = river.points.slice(0, mergePointIndex + 1);
  const downstreamPoints = river.points.slice(mergePointIndex);
  return [
    createRiverHitStroke(river.id, river.points, Math.max(widthBeforeMerge, widthAfterMerge)),
    createRiverStroke(river.id, upstreamPoints, widthBeforeMerge),
    createRiverStroke(river.id, downstreamPoints, widthAfterMerge),
  ];
}

function findRiverMergePointIndex(river) {
  if (river.widthMergeCellId === null || river.widthMergeCellId === undefined) {
    return null;
  }

  const cellIndex = river.cellIds?.indexOf(river.widthMergeCellId) ?? -1;
  if (cellIndex < 0) {
    return null;
  }

  return 1 + (cellIndex * 2);
}

function createRiverStroke(riverId, points, width) {
  return createElement("polyline", {
    points: toSvgPoints(points),
    fill: "none",
    stroke: COLORS.seaFill,
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "data-river-id": riverId,
  });
}

function createRiverHitStroke(riverId, points, width) {
  return createElement("polyline", {
    points: toSvgPoints(points),
    fill: "none",
    stroke: COLORS.riverHit,
    "stroke-width": Math.max(30, width + 18),
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "data-river-id": riverId,
  });
}

function createRiverEndpointGroup(segments) {
  const canonicalRiverSegments = Array.isArray(segments)
    ? segments.filter((segment) => segment.features?.river)
    : [];
  if (!canonicalRiverSegments.length) {
    return null;
  }

  const group = createElement("g", {
    "pointer-events": "none",
  });
  const seen = new Set();

  canonicalRiverSegments.forEach((segment) => {
    [segment.from, segment.to].forEach((point) => {
      const key = `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      group.append(
        createElement("circle", {
          cx: point.x,
          cy: point.y,
          r: RIVER_ENDPOINT_RADIUS,
          fill: COLORS.riverEndpoint,
          stroke: COLORS.seaEdge,
          "stroke-width": 1.35,
          "data-river-endpoint": "true",
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
