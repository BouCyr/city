/*
 * WHAT: Segment post-parish land edges before field dispatch.
 * HOW: Preserve sea/coast and smoothed parish-border paths, resample remaining land edges, and rebuild routes.
 * WHY: Later field steps should consume canonical sampled lot boundaries.
 */

import { DEFAULT_SEGMENT_LENGTH, convertLotGeometryToLandEdgeSegmentation } from "../map-model.js";
import { buildRouteGraph } from "../route-graph.js";
import { appendStoredRoadNetworkRoutes } from "../road-network-stored-routes.js";

export function runBuildLandEdgeGeometryStep(map) {
  const geometryMap = convertLotGeometryToLandEdgeSegmentation(map, DEFAULT_SEGMENT_LENGTH * 2);
  const routeGraph = appendStoredRoadNetworkRoutes(buildRouteGraph(geometryMap), geometryMap, [
    ...(map.roadNetwork?.streetRoutes || []),
    ...(map.roadNetwork?.virtualRoadRoutes || []),
  ]);
  const nextMap = {
    ...geometryMap,
    routeGraph,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.6 / Land edges segmentation",
        map: nextMap,
      },
    ],
  };
}
