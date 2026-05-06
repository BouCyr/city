/*
 * WHAT: Normalize post-parish lot geometry and smooth inter-parish borders before field dispatch.
 * HOW: Preserve sea/coast edges, curve eligible parish-border chains, and resample the remaining land edges.
 * WHY: Later steps should consume one canonical sampled geometry with parish borders already baked in.
 */

import { DEFAULT_SEGMENT_LENGTH, convertLotGeometryToLandEdgeGeometry } from "../map-model.js";
import { buildRouteGraph } from "../route-graph.js";

export function runBuildLandEdgeGeometryStep(map) {
  const geometryMap = convertLotGeometryToLandEdgeGeometry(map, DEFAULT_SEGMENT_LENGTH * 2);
  const nextMap = {
    ...geometryMap,
    routeGraph: buildRouteGraph(geometryMap),
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.3 / Land edges + parish borders",
        map: nextMap,
      },
    ],
  };
}
