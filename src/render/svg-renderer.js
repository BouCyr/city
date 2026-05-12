/*
 * WHAT: Render the current replay frame into an inline SVG map view.
 * HOW: Rebuild SVG groups for the background, lots, canonical segments, rivers, and fallback points each time a frame changes.
 * WHY: SVG keeps the map crisp at any zoom level and matches the viewport controls used by the UI.
 */

import { getMapGeometry } from "../generator/map-model.js";
import { computeSeaDistances } from "../generator/river-path.js";
import { Delaunay } from "../lib/d3-delaunay/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_DIVISIONS = 12;
const EDGE_STROKE_WIDTH = 2.55;
const SEGMENT_ENDPOINT_RADIUS = 3.0;
const RIVER_SEGMENT_SIZE_BONUS = 6;
const RIVER_OUTER_WIDTH_BONUS = 6;
const RIVER_OUTER_WIDTH_OFFSET = -2;
const RIVER_INNER_WIDTH_REDUCTION = 4;
const PRIMARY_RIVER_STEP_INDEX = 6;
const RIVER_BRANCH_STEP_INDEX = 7;
const COASTLINE_MESH_STEP_INDEX = 8;
const RIVER_LOT_GEOMETRY_STEP_INDEX = 10;
const ROUTE_GRAPH_STEP_INDEX = 10;
const PARISH_CLUSTERING_STEP_INDEX = 11;
const NEAR_EXCLAVE_STEP_INDEX = 12;
const NEAR_EXCLAVE_CORRECTIONS_STEP_INDEX = 13;
const FIELD_DISPATCH_STEP_INDEX = 14;
const COLORS = {
  background: "#f5f2ea",
  grid: "rgba(24, 33, 38, 0.06)",
  landFill: "#e3caa0",
  seaDistanceNear: "#ead3ab",
  seaDistanceFar: "#6d4529",
  centerFill: "#efc8c3",
  point: "#d6693c",
  edge: "#1a2026",
  seaFill: "#7ebbd4",
  seaEdge: "#1f4e72",
  riverHit: "rgba(0, 0, 0, 0)",
  routeNode: "#18232b",
  routeNodeHit: "rgba(0, 0, 0, 0)",
  routeNodeSea: "#2f7fa1",
  routeNodeCoast: "#f4efe5",
  routeNodeRiver: "#2d77c6",
  routeNodeCrossing: "#f08a24",
  alley: "#777777",
  wild: "#8a5a2b",
  road: "#2a2219",
  bridge: "#f08a24",
  nearExclave: "#ce3d3d",
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
  const useRiverStrokeDebug = isRiverStrokeDebugStep(map);
  const layer = createElement("g");
  layer.append(
    createLotsGroup(lots, map),
    createSegmentsGroup(segments, map),
    createRouteGraphAlleyGroup(map),
    useRiverStrokeDebug
      ? createRiverDistanceDebugGroup(map)
      : createElement("g"),
    useCanonicalRiverGeometry
      ? createElement("g")
      : createRiversGroup(map.rivers || [], segments),
    createParishCentersGroup(map),
    createRouteGraphNodesGroup(map),
  );

  if (!lots.length) {
    layer.append(createPointsGroup(map.points));
  }

  return layer;
}

function createParishCentersGroup(map) {
  const group = createElement("g", {
    "pointer-events": "none",
  });
  if ((map.meta?.stepIndex ?? -1) < PARISH_CLUSTERING_STEP_INDEX || !Array.isArray(map.parishCenters)) {
    return group;
  }

  map.parishCenters.forEach((center) => {
    group.append(
      createElement("circle", {
        cx: center.x,
        cy: center.y,
        r: 30,
        fill: center.color || "#18232b",
        stroke: "none",
        "stroke-width": 7,
        opacity: 0.92,
        "data-parish-id": center.parishId,
        "data-center-lot-id": center.lotId,
        "data-center-node-id": center.nodeId ?? "",
      }),
      createElement("text", {
        x: center.x,
        y: center.y + 10,
        fill: "#f7f3e8",
        stroke: "#18232b",
        "stroke-width": 4,
        "paint-order": "stroke",
        "font-size": 32,
        "font-weight": 800,
        "text-anchor": "middle",
        "pointer-events": "none",
      }, center.letter || String(center.parishId)),
    );
  });

  return group;
}

function createRouteGraphNodesGroup(map) {
  const group = createElement("g");
  const stepIndex = map.meta?.stepIndex ?? -1;
  if ((stepIndex !== ROUTE_GRAPH_STEP_INDEX && stepIndex !== PARISH_CLUSTERING_STEP_INDEX) || !Array.isArray(map.routeGraph?.nodes)) {
    return group;
  }

  const visualGroup = createElement("g", {
    "pointer-events": "none",
  });
  const hitGroup = createElement("g", {
    "pointer-events": "all",
  });

  const nodes = map.routeGraph.nodes.filter((node) => isInteractiveRouteNode(node, stepIndex));
  createRouteNodeVoronoiHitPolygons(nodes, map.meta?.size).forEach((hitPolygon) => {
    hitGroup.append(
      createElement("polygon", {
        points: toSvgPoints(hitPolygon.points),
        fill: COLORS.routeNodeHit,
        opacity: 0,
        "data-route-node-id": hitPolygon.nodeId,
      }),
    );
  });

  nodes.forEach((node) => {
    visualGroup.append(
      createElement("circle", {
        cx: node.x,
        cy: node.y,
        r: routeNodeRadius(node),
        fill: routeNodeFill(node),
        stroke: "#f8f2e8",
        "stroke-width": 1.7,
        opacity: 0.94,
      }),
    );
  });

  group.append(visualGroup, hitGroup);
  return group;
}

function createRouteNodeVoronoiHitPolygons(nodes, size) {
  const boundsSize = Number.isFinite(size) ? size : 3000;
  if (!nodes.length) {
    return [];
  }

  const delaunay = Delaunay.from(nodes.map((node) => [node.x, node.y]));
  const voronoi = delaunay.voronoi([0, 0, boundsSize, boundsSize]);
  return nodes.map((node, index) => {
    const points = sanitizeVoronoiCell(voronoi.cellPolygon(index));
    return points.length >= 3
      ? { nodeId: node.id, points }
      : { nodeId: node.id, points: createFallbackHitSquare(node) };
  });
}

function sanitizeVoronoiCell(cell) {
  if (!Array.isArray(cell)) {
    return [];
  }

  const points = cell
    .map((point) => ({ x: point[0], y: point[1] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) {
    points.pop();
  }
  return points;
}

function createFallbackHitSquare(node) {
  const radius = 18;
  return [
    { x: node.x - radius, y: node.y - radius },
    { x: node.x + radius, y: node.y - radius },
    { x: node.x + radius, y: node.y + radius },
    { x: node.x - radius, y: node.y + radius },
  ];
}

function routeNodeRadius(node) {
  if (node.type === "river_crossing" || node.type === "river_mouth") {
    return 5.4;
  }
  return node.routeIds?.length > 2 ? 4.4 : 3.2;
}

function isInteractiveRouteNode(node, stepIndex) {
  if (stepIndex === PARISH_CLUSTERING_STEP_INDEX) {
    return node.type === "lot_center";
  }
  return node.type === "river_crossing" || node.type === "river_mouth" || (node.routeIds || []).length > 2;
}

function routeNodeFill(node) {
  if (node.features?.bridge) {
    return COLORS.bridge;
  }
  if (node.type === "lot_center") {
    return COLORS.routeNode;
  }
  if (node.type === "sea") {
    return COLORS.routeNodeSea;
  }
  if (node.type === "coast" || node.type === "river_mouth") {
    return COLORS.routeNodeCoast;
  }
  if (node.type === "river") {
    return COLORS.routeNodeRiver;
  }
  if (node.type === "river_crossing") {
    return COLORS.routeNodeCrossing;
  }
  return COLORS.routeNode;
}

function createLotsGroup(lots, map) {
  const group = createElement("g");
  const useSeaDistanceFill = (map.meta?.stepIndex ?? -1) < COASTLINE_MESH_STEP_INDEX && isRiverDistanceDebugStep(map);
  const seaDistances = useSeaDistanceFill && (Array.isArray(map.cells) || Array.isArray(lots))
    ? computeSeaDistances(Array.isArray(map.cells) && map.cells.length > 0 ? map.cells : lots)
    : null;
  const baseItems = Array.isArray(map.cells) && map.cells.length > 0 ? map.cells : lots;
  const maxLandSeaDistance = seaDistances
    ? Math.max(1, ...baseItems.filter((item) => item.features.land && Number.isFinite(seaDistances[item.id])).map((item) => seaDistances[item.id]))
    : 1;

  // Pre-calculate data for parish boundaries
  const lotParishMap = new Map();
  const parishLotsMap = new Map();
  lots.forEach(l => {
    if (l.parishId !== null && l.parishId !== undefined) {
      lotParishMap.set(l.id, l.parishId);
      if (!parishLotsMap.has(l.parishId)) parishLotsMap.set(l.parishId, []);
      parishLotsMap.get(l.parishId).push(l);
    }
  });

  const { segments } = getMapGeometry(map);

  const defs = createElement("defs");
  group.append(defs);

  // 1. Draw all lot polygons
  lots.forEach((lot) => {
    if (lot.polygon.length < 3) return;
    group.append(
      createElement("polygon", {
        points: toSvgPoints(lot.polygon),
        fill: fillForLot(lot, seaDistances, maxLandSeaDistance, map),
        "data-lot-id": lot.id,
        "data-cell-id": lot.id,
      }),
    );
  });

  // 2. Identify boundary segments between a parish lot and anything outside the same parish (including coast/water).
  const parishBoundarySegments = new Map(); // parishId -> Array of segments
  segments.forEach(s => {
    const lId = s.leftLotId ?? s.leftCellId;
    const rId = s.rightLotId ?? s.rightCellId;
    const lParish = lId !== null ? lotParishMap.get(lId) : null;
    const rParish = rId !== null ? lotParishMap.get(rId) : null;
    const hasLParish = lParish !== null && lParish !== undefined;
    const hasRParish = rParish !== null && rParish !== undefined;
    const isInterParish = hasLParish && hasRParish && lParish !== rParish;

    if (!hasLParish && !hasRParish) {
      return;
    }
    if (hasLParish && hasRParish && !isInterParish) {
      return;
    }
    if (s.features?.river && !isInterParish) {
      return;
    }

    if (hasLParish) {
      if (!parishBoundarySegments.has(lParish)) parishBoundarySegments.set(lParish, []);
      parishBoundarySegments.get(lParish).push(s);
    }
    if (hasRParish && lParish !== rParish) {
      if (!parishBoundarySegments.has(rParish)) parishBoundarySegments.set(rParish, []);
      parishBoundarySegments.get(rParish).push(s);
    }
  });

  // 3. Draw parish borders
  parishBoundarySegments.forEach((boundarySegments, parishId) => {
    const colorData = map.parishColors?.[parishId];
    if (!colorData) return;

    // Create a clipPath for the entire parish (union of its lots)
    const clipId = `clip-parish-${parishId}`;
    const clipPath = createElement("clipPath", { id: clipId });
    parishLotsMap.get(parishId).forEach(lot => {
      if (lot.polygon.length >= 3) {
        clipPath.append(createElement("polygon", { points: toSvgPoints(lot.polygon) }));
      }
    });
    defs.append(clipPath);

    // Build the path data for the boundary
    const d = buildParishPathData(boundarySegments);
    if (d) {
      group.append(createElement("path", {
        d,
        stroke: colorData.border,
        "stroke-width": 60,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        fill: "none",
        "clip-path": `url(#${clipId})`
      }));
    }
  });

  return group;
}

function fillForLot(lot, seaDistances, maxLandSeaDistance, map) {
  if (lot.features.sea) {
    return COLORS.seaFill;
  }
  const stepIndex = map.meta?.stepIndex ?? -1;
  if ((stepIndex === NEAR_EXCLAVE_STEP_INDEX || stepIndex === NEAR_EXCLAVE_CORRECTIONS_STEP_INDEX) && lot.nearExclave) {
    return mixHex(COLORS.landFill, COLORS.nearExclave, 0.55);
  }
  if ((map.meta?.stepIndex ?? -1) >= COASTLINE_MESH_STEP_INDEX && lot.features.land) {
    return COLORS.landFill;
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

function createSegmentsGroup(segments, map) {
  const stepIndex = map.meta?.stepIndex ?? -1;
  const hideDots = stepIndex > FIELD_DISPATCH_STEP_INDEX;
  const strokeWidth = stepIndex >= PARISH_CLUSTERING_STEP_INDEX ? EDGE_STROKE_WIDTH * 1.55 : EDGE_STROKE_WIDTH;
  const group = createElement("g", {
    "pointer-events": "none",
  });
  const lineGroup = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
    "stroke-width": strokeWidth,
  });
  const riverLineGroup = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
  });
  const dotGroup = createElement("g");
  const riverDotGroup = createElement("g");

  segments.forEach((segment) => {
    if (!shouldDrawSegment(segment, stepIndex)) {
      return;
    }

    const leftId = segment.leftLotId ?? segment.leftCellId ?? "";
    const rightId = segment.rightLotId ?? segment.rightCellId ?? "";
    const isRiver = Boolean(segment.features.river);
    const stroke = segment.features.wild || segment.features.routeType === "wild"
        ? COLORS.wild
        : segment.features.road || segment.features.street || segment.features.routeType === "road" || segment.features.routeType === "street"
        ? COLORS.road
        : segment.features.coast
        ? COLORS.seaEdge
        : segment.features.sea
        ? COLORS.seaEdge
        : COLORS.edge;

    if (isRiver) {
      riverLineGroup.append(
        createSegmentLine(segment, COLORS.seaEdge, strokeWidth * 3, leftId, rightId),
        createSegmentLine(segment, COLORS.seaFill, strokeWidth, leftId, rightId),
      );
      if (!hideDots) {
        riverDotGroup.append(
          createSegmentDot(segment.from, COLORS.seaFill, 3 * strokeWidth / 2, COLORS.seaEdge),
          createSegmentDot(segment.to, COLORS.seaFill, 3 * strokeWidth / 2, COLORS.seaEdge),
        );
      }
      return;
    }

    const line = createSegmentLine(segment, stroke, strokeWidth, leftId, rightId);
    const fromDot = createSegmentDot(segment.from, stroke, SEGMENT_ENDPOINT_RADIUS);
    const toDot = createSegmentDot(segment.to, stroke, SEGMENT_ENDPOINT_RADIUS);
    lineGroup.append(line);
    if (!hideDots) {
      dotGroup.append(fromDot, toDot);
    }
  });
  group.append(lineGroup, dotGroup, riverLineGroup, riverDotGroup);
  return group;
}

function shouldDrawSegment(segment) {
  return Boolean(
    segment.features?.river
    || segment.features?.coast
    || segment.features?.sea
    || segment.features?.road
    || segment.features?.street
    || segment.features?.alley
    || segment.features?.routeType === "road"
    || segment.features?.routeType === "street"
    || segment.features?.routeType === "alley"
    || segment.features?.wild
    || segment.features?.routeType === "wild",
  );
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

function createRouteGraphAlleyGroup(map) {
  const group = createElement("g", {
    fill: "none",
    "stroke-linecap": "round",
    "pointer-events": "none",
  });
  const stepIndex = map.meta?.stepIndex ?? -1;
  if (stepIndex < PARISH_CLUSTERING_STEP_INDEX || !Array.isArray(map.routeGraph?.routes)) {
    return group;
  }

  const nodesById = new Map(map.routeGraph.nodes.map((node) => [node.id, node]));
  map.routeGraph.routes
    .filter((route) => {
      if (stepIndex === PARISH_CLUSTERING_STEP_INDEX) {
        return route.type === "alley" && route.features?.lotCenterAlley;
      }
      if (stepIndex >= PARISH_CLUSTERING_STEP_INDEX) {
        return (route.type === "alley" || route.type === "road" || route.type === "street" || route.type === "river" || route.type === "coast") && !route.features?.lotCenterAlley;
      }
      return false;
    })
    .forEach((route) => {
      const from = nodesById.get(route.fromNodeId);
      const to = nodesById.get(route.toNodeId);
      if (!from || !to) {
        return;
      }
      group.append(
        createElement("line", {
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          stroke: route.type === "road" || route.type === "street"
            ? COLORS.road
            : route.type === "alley"
              ? COLORS.alley
              : COLORS.seaEdge,
          "stroke-width": route.type === "road" || route.type === "street" ? EDGE_STROKE_WIDTH * 2.6 : EDGE_STROKE_WIDTH * 1.25,
          opacity: route.type === "road" || route.type === "street" ? 0.92 : route.type === "alley" ? 0.56 : 0.72,
          "data-route-id": route.id,
        }),
      );
    });

  return group;
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
  const items = (Array.isArray(map.cells) && map.cells.length > 0) ? map.cells : (Array.isArray(map.lots) ? map.lots : []);
  if (!items.length || !items.some((item) => item.features?.sea)) {
    return group;
  }

  const seaDistances = computeSeaDistances(items);
  const itemById = new Map(items.map((item) => [item.id, item]));
  (map.rivers || []).forEach((river) => {
    if (!Array.isArray(river.cellIds) || !Array.isArray(river.points) || river.cellIds.length < 1 || river.points.length < 2) {
      return;
    }

    createRiverDebugSegments(river, seaDistances, itemById).forEach((segment) => {
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
  return (map.meta?.stepIndex ?? -1) >= PRIMARY_RIVER_STEP_INDEX;
}

function isRiverStrokeDebugStep(map) {
  const index = map.meta?.stepIndex ?? -1;
  return index === PRIMARY_RIVER_STEP_INDEX || index === RIVER_BRANCH_STEP_INDEX;
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

function createElement(tagName, attributes = {}, text = null) {
  const element = document.createElementNS(SVG_NS, tagName);

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });
  if (text !== null && text !== undefined) {
    element.textContent = String(text);
  }

  return element;
}

function buildParishPathData(segments) {
  if (segments.length === 0) return null;

  const getVKey = (v) => `${v.x.toFixed(3)},${v.y.toFixed(3)}`;
  
  const edges = segments.map((s, i) => ({
    id: i,
    v1: getVKey(s.from),
    v2: getVKey(s.to),
    p1: s.from,
    p2: s.to,
    used: false
  }));
  
  const vToEdges = new Map();
  edges.forEach(e => {
    if (!vToEdges.has(e.v1)) vToEdges.set(e.v1, []);
    if (!vToEdges.has(e.v2)) vToEdges.set(e.v2, []);
    vToEdges.get(e.v1).push(e);
    vToEdges.get(e.v2).push(e);
  });

  let d = "";

  while (true) {
    let startVKey = null;
    for (const [vKey, connected] of vToEdges.entries()) {
      const unused = connected.filter(e => !e.used);
      if (unused.length > 0 && unused.length % 2 !== 0) {
        startVKey = vKey;
        break;
      }
    }
    if (startVKey === null) {
      for (const [vKey, connected] of vToEdges.entries()) {
        if (connected.some(e => !e.used)) {
          startVKey = vKey;
          break;
        }
      }
    }

    if (startVKey === null) break;

    let currentVKey = startVKey;
    let pts = [];
    
    while (true) {
      const edge = vToEdges.get(currentVKey).find(e => !e.used);
      if (!edge) break;

      if (pts.length === 0) {
        pts.push(edge.v1 === currentVKey ? edge.p1 : edge.p2);
      }
      
      edge.used = true;
      const nextVKey = edge.v1 === currentVKey ? edge.v2 : edge.v1;
      const nextPt = edge.v1 === currentVKey ? edge.p2 : edge.p1;
      pts.push(nextPt);
      currentVKey = nextVKey;
      
      if (currentVKey === startVKey) break;
    }

    if (pts.length > 1) {
      d += `M ${pts[0].x} ${pts[0].y} `;
      for (let i = 1; i < pts.length; i++) {
        d += `L ${pts[i].x} ${pts[i].y} `;
      }
      if (getVKey(pts[pts.length - 1]) === getVKey(pts[0]) && pts.length > 2) {
        d += "Z ";
      }
    }
  }

  return d.trim();
}
