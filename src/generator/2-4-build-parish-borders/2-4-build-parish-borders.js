/*
 * WHAT: Smooth inter-parish lot borders without segmenting the remaining land edges.
 * HOW: Apply parish-border replacement paths and rebuild lot polygons/relationships from those paths.
 * WHY: Parish border smoothing should be inspectable before the later land-edge segmentation pass.
 */

import { DEFAULT_SEGMENT_LENGTH, convertLotGeometryToParishBorderGeometry } from "../map-model.js";
import { buildRouteGraph } from "../route-graph.js";
import { appendStoredRoadNetworkRoutes } from "../road-network-stored-routes.js";

export function runBuildParishBordersStep(map) {
  const borderMap = convertLotGeometryToParishBorderGeometry(map, DEFAULT_SEGMENT_LENGTH * 2);
  const routeGraph = appendStoredRoadNetworkRoutes(buildRouteGraph(borderMap), borderMap, [
    ...(map.roadNetwork?.streetRoutes || []),
    ...(map.roadNetwork?.virtualRoadRoutes || []),
  ]);
  const nextMap = {
    ...borderMap,
    routeGraph,
  };
  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.4 / Parish borders",
        map: nextMap,
      },
    ],
  };
}
