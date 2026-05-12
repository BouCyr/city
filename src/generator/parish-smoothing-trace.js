/*
 * WHAT: Build tutorial frames for the parish-border smoothing pass.
 * HOW: Reuse the production parish-border trace and step 2.5 parish-border rebuild on a fixed generated map.
 * WHY: The tutorial should explain the real geometry and topology changes applied before field dispatch.
 */

import { convertLotGeometryToParishBorderGeometry } from "./map-model.js";
import { buildParishBorderTrace } from "./parish-border-model.js";

const TUTORIAL_SEGMENT_LENGTH = 40;

export function buildParishSmoothingTutorialTrace(dataset) {
  const inputMap = dataset?.map;
  if (!inputMap) {
    return {
      dataset: dataset || { name: "Parish smoothing" },
      frames: [frame("Parish smoothing", "No generated parish map is available for this tutorial dataset.", {})],
    };
  }

  const trace = buildParishBorderTrace(inputMap, { segmentLength: TUTORIAL_SEGMENT_LENGTH });
  const finalMap = convertLotGeometryToParishBorderGeometry(inputMap, TUTORIAL_SEGMENT_LENGTH);
  const chainSegments = trace.chains.flatMap((chain, chainIndex) =>
    chain.segmentIds.map((segmentId) => ({ segmentId, chainIndex, smoothed: chain.smoothed }))
  );
  const chainClassBySegmentId = new Map(chainSegments.map((entry) => [
    entry.segmentId,
    entry.smoothed ? `parish-chain-edge chain-${entry.chainIndex % 4}` : "parish-chain-edge unsmoothed",
  ]));

  return {
    dataset,
    trace,
    frames: [
      frame("Generated parish map", "This tutorial starts from the real step 2.2 output: a full-land deterministic map with 15 lots already clustered into 3 parishes.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({
          ...segment,
          className: "parish-muted-edge",
        })),
      }),
      frame("Classify parish borders", "Only segments between two different parishes are eligible for smoothing. Interior parish edges stay straight and untouched.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({
          ...segment,
          className: trace.parishBoundarySegmentIds.has(segment.id) ? "parish-boundary-edge" : "parish-muted-edge",
        })),
      }),
      frame("Trace compatible border chains", "Eligible segments are grouped only when they separate the same two parishes. Vertices shared by more than two parishes stay pinned and break the chain.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({
          ...segment,
          className: chainClassBySegmentId.get(segment.id) || "parish-muted-edge",
        })),
      }),
      frame("Pin protected border nodes", "Coast, river, sea, and map-boundary nodes stay fixed here. Multi-parish border hubs also stay fixed so border movement cannot break topology.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({
          ...segment,
          className: trace.parishBoundarySegmentIds.has(segment.id) ? "parish-boundary-edge" : "parish-muted-edge",
        })),
        points: Array.from(trace.protectedVertexKeys)
          .map((vertexKey) => trace.pointByKey.get(vertexKey))
          .filter(Boolean)
          .map((point) => ({ point, className: "parish-pinned-point" })),
      }),
      frame("Build Bezier border paths", "The smoothing curves are computed on the unsegmented border graph first, then parish-border geometry is rebuilt from those paths.", {
        lots: inputMap.lots,
        segments: inputMap.segments?.map((segment) => ({
          ...segment,
          className: "parish-muted-edge",
        })),
        curves: trace.chains
          .filter((chain) => chain.smoothed)
          .flatMap((chain) => (chain.curves || []).map((curve) => ({
            points: curve.points,
            className: "parish-bezier-guide",
          }))),
        points: trace.chains
          .filter((chain) => chain.smoothed)
          .flatMap((chain) => (chain.curves || []).flatMap((curve) => ([
            { point: curve.control, label: "C", className: "parish-control-point" },
            { point: curve.start, label: "M", className: "parish-midpoint" },
            { point: curve.end, label: "M", className: "parish-midpoint" },
          ]))),
      }),
      frame("Rebuilt parish borders", "Parish borders are sampled along their Bezier paths and non-border land edges remain unchanged in this tutorial model.", {
        lots: finalMap.lots,
        segments: finalMap.segments?.map((segment) => ({
          ...segment,
          className: segment.features?.parishBoundarySmoothed
            ? "parish-final-smoothed-edge"
            : segment.features?.parishBoundary
              ? "parish-final-boundary-edge"
              : "parish-final-edge",
        })),
      }),
    ],
  };
}

function frame(title, body, geometry) {
  return { title, body, geometry };
}
