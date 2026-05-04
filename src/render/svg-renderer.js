/*
 * WHAT: Render the current replay frame into an inline SVG map view.
 * HOW: Rebuild SVG groups for the background, lots, canonical segments, rivers, and fallback points each time a frame changes.
 * WHY: SVG keeps the map crisp at any zoom level and matches the viewport controls used by the UI.
 */

import { getMapGeometry } from "../generator/map-model.js";
import { computeSeaDistances } from "../generator/river-path.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_DIVISIONS = 12;
const EDGE_STROKE_WIDTH = 2.55;
const SEGMENT_ENDPOINT_RADIUS = 3.0;
const RIVER_SEGMENT_SIZE_BONUS = 6;
const RIVER_OUTER_WIDTH_BONUS = 6;
const RIVER_OUTER_WIDTH_OFFSET = -2;
const RIVER_INNER_WIDTH_REDUCTION = 4;
const PRIMARY_RIVER_STEP_INDEX = 5;
const RIVER_BRANCH_STEP_INDEX = 6;
const RIVER_LOT_GEOMETRY_STEP_INDEX = 9;
const COLORS = {
  background: "#f5f2ea",
  grid: "rgba(24, 33, 38, 0.06)",
  landFill: "#c8ae89",
  seaDistanceNear: "#ead3ab",
  seaDistanceFar: "#6d4529",
  centerFill: "#efc8c3",
  point: "#d6693c",
  edge: "#1a2026",
  seaFill: "#7ebbd4",
  seaEdge: "#1f4e72",
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
  const useCanonicalRiverGeometry = (map.meta?.stepIndex ?? -1) >= RIVER_LOT_GEOMETRY_STEP_INDEX;
  const useRiverDistanceDebug = isRiverDistanceDebugStep(map);
  const layer = createElement("g");
  layer.append(
    createLotsGroup(lots, map),
    createTessellationGroup(map.tessellation, map),
    createSegmentsGroup(segments),
    useCanonicalRiverGeometry
      ? createElement("g")
      : useRiverDistanceDebug
        ? createRiverDistanceDebugGroup(map)
        : createRiversGroup(map.rivers || [], segments),
  );

  if (!lots.length) {
    layer.append(createPointsGroup(map.points));
  }

  return layer;
}

function createLotsGroup(lots, map) {
  const group = createElement("g");
  const seaDistances = isRiverDistanceDebugStep(map) && Array.isArray(map.cells)
    ? computeSeaDistances(map.cells)
    : null;
  const maxLandSeaDistance = seaDistances
    ? Math.max(1, ...map.cells.filter((cell) => cell.features.land && Number.isFinite(seaDistances[cell.id])).map((cell) => seaDistances[cell.id]))
    : 1;

  lots.forEach((lot) => {
    if (lot.polygon.length < 3) {
      return;
    }

    group.append(
      createElement("polygon", {
        points: toSvgPoints(lot.polygon),
        fill: fillForLot(lot, seaDistances, maxLandSeaDistance),
        "data-lot-id": lot.id,
        "data-cell-id": lot.id,
      }),
    );
  });

  return group;
}

function fillForLot(lot, seaDistances, maxLandSeaDistance) {
  if (lot.features.sea) {
    return COLORS.seaFill;
  }
  if (seaDistances && lot.features.land && Number.isFinite(seaDistances[lot.id])) {
    return seaDistanceFill(seaDistances[lot.id], maxLandSeaDistance);
  }
  if (lot.features.cityCenter) {
    return COLORS.centerFill;
  }
  return COLORS.landFill;
}

function seaDistanceFill(seaDistance, maxLandSeaDistance) {
  const ratio = maxLandSeaDistance <= 1
    ? 0
    : Math.min(1, Math.max(0, (seaDistance - 1) / (maxLandSeaDistance - 1)));
  return mixHex(COLORS.seaDistanceNear, COLORS.seaDistanceFar, ratio);
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
  const riverLineGroup = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
  });
  const dotGroup = createElement("g");
  const riverDotGroup = createElement("g");

  segments.forEach((segment) => {
    const leftId = segment.leftLotId ?? segment.leftCellId ?? "";
    const rightId = segment.rightLotId ?? segment.rightCellId ?? "";
    const isRiver = Boolean(segment.features.river);
    const stroke = segment.features.sea
        ? COLORS.seaEdge
        : COLORS.edge;

    if (isRiver) {
      riverLineGroup.append(
        createSegmentLine(segment, COLORS.seaEdge, EDGE_STROKE_WIDTH*3, leftId, rightId),
        createSegmentLine(segment, COLORS.seaFill, EDGE_STROKE_WIDTH, leftId, rightId),
      );
      riverDotGroup.append(
        createSegmentDot(segment.from, COLORS.seaFill, 3*EDGE_STROKE_WIDTH / 2, COLORS.seaEdge),
        createSegmentDot(segment.to, COLORS.seaFill, 3*EDGE_STROKE_WIDTH / 2, COLORS.seaEdge),
      );
      return;
    }

    const line = createSegmentLine(segment, stroke, EDGE_STROKE_WIDTH, leftId, rightId);
    const fromDot = createSegmentDot(segment.from, stroke, SEGMENT_ENDPOINT_RADIUS);
    const toDot = createSegmentDot(segment.to, stroke, SEGMENT_ENDPOINT_RADIUS);
    lineGroup.append(line);
    dotGroup.append(fromDot, toDot);
  });
  group.append(lineGroup, dotGroup, riverLineGroup, riverDotGroup);
  return group;
}

function createSegmentLine(segment, stroke, strokeWidth, leftId, rightId) {
  return createElement("line", {
    x1: segment.from.x,
    y1: segment.from.y,
    x2: segment.to.x,
    y2: segment.to.y,
    stroke,
    "stroke-width": strokeWidth,
    "data-segment-id": segment.id,
    "data-edge-id": segment.id,
    "data-left-lot-id": leftId,
    "data-right-lot-id": rightId,
    "data-left-cell-id": leftId,
    "data-right-cell-id": rightId,
  });
}

function createSegmentDot(point, fill, radius, stroke = null) {
  const attributes = {
    cx: point.x,
    cy: point.y,
    r: radius,
    fill,
  };
  if (stroke) {
    attributes.stroke = stroke;
    attributes["stroke-width"] = 2;
  }
  return createElement("circle", attributes);
}

function createTessellationGroup(tessellation, map) {
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

  return group;
}

function createRiverDistanceDebugGroup(map) {
  const group = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "pointer-events": "none",
  });
  if (!Array.isArray(map.cells) || !map.cells.some((cell) => cell.features.sea)) {
    return group;
  }

  const seaDistances = computeSeaDistances(map.cells);
  const cellById = new Map(map.cells.map((cell) => [cell.id, cell]));
  (map.rivers || []).forEach((river) => {
    if (!Array.isArray(river.cellIds) || !Array.isArray(river.points) || river.cellIds.length < 1 || river.points.length < 2) {
      return;
    }

    createRiverDebugSegments(river, seaDistances, cellById).forEach((segment) => {
      group.append(
        createElement("line", {
          x1: segment.from.x,
          y1: segment.from.y,
          x2: segment.to.x,
          y2: segment.to.y,
          stroke: segment.stroke,
          "stroke-width": Math.max(8, (river.strokeWidth || 18) * 0.55),
          "data-river-id": river.id,
          "data-from-cell-id": segment.fromCellId ?? "",
          "data-to-cell-id": segment.toCellId ?? "",
        }),
      );
    });
  });

  return group;
}

function createRiverDebugSegments(river, seaDistances, cellById) {
  const segments = [];
  const points = river.points;
  const cellIds = river.cellIds;
  const firstCell = cellById.get(cellIds[0]);
  if (!firstCell) {
    return segments;
  }

  let pointIndex = 0;
  if (!samePoint(points[0], firstCell.centroid)) {
    segments.push({
      from: points[0],
      to: firstCell.centroid,
      stroke: riverDownhillStroke(),
      fromCellId: "",
      toCellId: firstCell.id,
    });
    pointIndex = 1;
  }

  for (let cellIndex = 0; cellIndex < cellIds.length - 1; cellIndex += 1) {
    const fromCell = cellById.get(cellIds[cellIndex]);
    const toCell = cellById.get(cellIds[cellIndex + 1]);
    const edgeMiddle = points[pointIndex + 1];
    if (!fromCell || !toCell || !edgeMiddle) {
      break;
    }

    const stroke = riverDirectionStroke(seaDistances[fromCell.id], seaDistances[toCell.id]);
    segments.push(
      {
        from: fromCell.centroid,
        to: edgeMiddle,
        stroke,
        fromCellId: fromCell.id,
        toCellId: toCell.id,
      },
      {
        from: edgeMiddle,
        to: toCell.centroid,
        stroke,
        fromCellId: fromCell.id,
        toCellId: toCell.id,
      },
    );
    pointIndex += 2;
  }

  const lastCell = cellById.get(cellIds[cellIds.length - 1]);
  const finalPoint = points[pointIndex + 1];
  if (lastCell && finalPoint && !samePoint(finalPoint, lastCell.centroid)) {
    segments.push({
      from: lastCell.centroid,
      to: finalPoint,
      stroke: riverDownhillStroke(),
      fromCellId: lastCell.id,
      toCellId: "",
    });
  }

  return segments;
}

function riverDirectionStroke(fromSeaDistance, toSeaDistance) {
  if (toSeaDistance < fromSeaDistance) {
    return riverDownhillStroke();
  }
  if (toSeaDistance === fromSeaDistance) {
    return "#e58d27";
  }
  return "#d43f2f";
}

function riverDownhillStroke() {
  return "#2e9a4b";
}

function samePoint(first, second) {
  return Math.abs(first.x - second.x) < 0.001 && Math.abs(first.y - second.y) < 0.001;
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

function isRiverDistanceDebugStep(map) {
  return map.meta?.stepIndex === PRIMARY_RIVER_STEP_INDEX || map.meta?.stepIndex === RIVER_BRANCH_STEP_INDEX;
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

function toSvgPoints(points) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function mixHex(first, second, ratio) {
  const firstRgb = hexToRgb(first);
  const secondRgb = hexToRgb(second);
  const mixed = firstRgb.map((value, index) => Math.round(value + (secondRgb[index] - value) * ratio));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

function createElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });

  return element;
}
