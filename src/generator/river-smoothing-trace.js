/*
 * WHAT: Build tutorial frames for the real river smoothing step.
 * HOW: Reuse the production river-point adjustments and smoothing helpers on a deterministic generated map.
 * WHY: The river tutorial should explain the actual 1.10 geometry pass, not a separate demo-only path.
 */

import { DEFAULT_SEGMENT_LENGTH } from "./map-model.js";
import {
  buildAdjustedRiverPointMap,
  buildRiverSegmentModel,
  findPrimaryMergePointIndex,
} from "./1-10-add-rivers-to-lot-geometry/1-10-add-rivers-to-lot-geometry.js";
import { inspectPinnedPolylineSmoothing } from "./polyline-smoothing.js";

const TUTORIAL_SEGMENT_LENGTH = DEFAULT_SEGMENT_LENGTH;

export function buildRiverTutorialTrace(dataset) {
  const inputMap = dataset?.map;
  const river = (inputMap?.rivers || [])[0] || null;
  const size = inputMap?.meta?.size || dataset?.size || 720;
  if (!inputMap || !river) {
    return {
      dataset: dataset || { name: "River smoothing" },
      frames: [frame("River smoothing", "No generated river is available for this tutorial dataset.", {})],
    };
  }

  const adjustedPointsByRiverId = buildAdjustedRiverPointMap(inputMap.rivers || []);
  const adjustedPoints = adjustedPointsByRiverId.get(river.id) || river.points || [];
  const pinnedPointKeys = buildPinnedPointKeySet(inputMap.rivers || [], adjustedPointsByRiverId);
  const smoothing = inspectPinnedPolylineSmoothing(adjustedPoints, pinnedPointKeys, TUTORIAL_SEGMENT_LENGTH);
  const riverGraph = buildRiverSegmentModel(inputMap.rivers || []);
  const finalSegments = riverGraph.segments
    .filter((segment) => segment.riverId === river.id)
    .map((segment) => ({
      ...segment,
      className: "river-final-segment",
    }));

  return {
    dataset: {
      ...dataset,
      size,
    },
    frames: [
      frame("Generated coastline-adjusted lots", "The tutorial starts from the real step 1.9 output: deterministic coastline-adjusted lots and canonical segments before river splitting.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({
          ...segment,
          className: segment.features?.coast ? "river-muted-edge" : "river-grid-edge",
        })),
      }),
      frame("Angular river path", "The stored river route still follows the generator's angular path through cells before the lot split step samples it into geometry.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({ ...segment, className: "river-muted-edge" })),
        rawPaths: [{ points: river.points, className: "river-raw-path" }],
        points: river.points.map((point, index) => ({
          point,
          label: String(index + 1),
          className: pinnedPointKeys.has(pointKey(point)) ? "river-pinned-point" : "river-control-point",
        })),
      }),
      frame("Adjusted merge and pinned points", "Before smoothing, tributary merges and primary width-change points are aligned exactly so the final sampled river geometry stays topologically consistent.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({ ...segment, className: "river-muted-edge" })),
        rawPaths: [{ points: adjustedPoints, className: "river-muted-path" }],
        points: adjustedPoints.map((point) => ({
          point,
          className: pinnedPointKeys.has(pointKey(point)) ? "river-pinned-point" : "river-control-point",
        })),
      }),
      frame("Build smoothing curves", "Each river bend uses the same midpoint-control quadratic construction as the production step. Pinned vertices split the sampled curves back onto exact merge and endpoint locations.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({ ...segment, className: "river-muted-edge" })),
        curves: smoothing.curves.map((curve) => ({ points: curve.points, className: "river-bezier-guide" })),
        points: [
          ...smoothing.curves.map((curve) => ({ point: curve.control, label: "R", className: "river-control-point" })),
          ...smoothing.curves.flatMap((curve) => {
            const points = [];
            if (curve.start) {
              points.push({ point: curve.start, label: "M", className: "river-midpoint" });
            }
            if (curve.end) {
              points.push({ point: curve.end, label: "M", className: "river-midpoint" });
            }
            return points;
          }),
          ...smoothing.curves
            .filter((curve) => curve.isPinned)
            .map((curve) => ({ point: curve.splitPoint, className: "river-pinned-point" })),
        ],
      }),
      frame("Final smoothed river segments", "The real 1.10 step emits ordinary river segments from the smoothed path, ready to split the coastline-adjusted lots.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({ ...segment, className: "river-muted-edge" })),
        rawPaths: [{ points: smoothing.smoothedPath, className: "river-muted-path" }],
        segmentsOverlay: finalSegments,
        points: smoothing.smoothedPath.map((point) => ({ point, className: "river-sample-point" })),
      }),
    ],
  };
}

function buildPinnedPointKeySet(rivers, adjustedPointsByRiverId) {
  const pinnedPointKeys = new Set();
  rivers.forEach((river) => {
    if (river.mergeCellId === null || river.mergeCellId === undefined) {
      return;
    }

    const riverPoints = adjustedPointsByRiverId.get(river.id) || river.points || [];
    const pointIndex = riverPoints.length - 1;
    if (pointIndex >= 0) {
      pinnedPointKeys.add(pointKey(riverPoints[pointIndex]));
    }
  });
  rivers.forEach((river) => {
    if (river.widthMergeCellId === null || river.widthMergeCellId === undefined) {
      return;
    }

    const mergePointIndex = findPrimaryMergePointIndex(river);
    const riverPoints = adjustedPointsByRiverId.get(river.id) || river.points || [];
    if (mergePointIndex !== null && riverPoints[mergePointIndex]) {
      pinnedPointKeys.add(pointKey(riverPoints[mergePointIndex]));
    }
  });
  return pinnedPointKeys;
}

function frame(title, body, geometry) {
  return { title, body, geometry };
}

function pointKey(point) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}
