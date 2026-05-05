/*
 * WHAT: Normalize the remaining lot geometry after coastline conversion.
 * HOW: Keep pure sea edges intact and resample every other edge into straight segments.
 * WHY: Downstream lot processing expects a stable segment-only geometry with shared vertices deduped.
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
        label: "Step 2.3 / Land edges",
        map: nextMap,
      },
    ],
  };
}
