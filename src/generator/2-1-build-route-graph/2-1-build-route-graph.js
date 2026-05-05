/*
 * WHAT: Materialize the canonical node/route graph after lot and river geometry are stable.
 * HOW: Convert deduplicated segment endpoints into nodes and classify each segment as a route.
 * WHY: Human-occupation steps need pathfinding-ready topology without replacing renderer geometry.
 */

import { buildRouteGraph } from "../route-graph.js";

export function runBuildRouteGraphStep(map) {
  const nextMap = {
    ...map,
    routeGraph: buildRouteGraph(map),
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2.1 / Route graph",
        map: nextMap,
      },
    ],
  };
}
