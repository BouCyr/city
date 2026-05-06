/*
 * WHAT: Build tutorial frames for the parish road-network pass.
 * HOW: Run the production road-network builder and expose center selection plus each promoted path.
 * WHY: The road-network demo should show the same path choices as step 2.3.
 */

import { buildRoadNetwork } from "./2-3-build-road-network/2-3-build-road-network.js";

export function buildRoadNetworkTutorialTrace(dataset) {
  const inputMap = dataset?.map;
  if (!inputMap) {
    return {
      dataset: dataset || { name: "Road network" },
      frames: [frame("Road network", "No generated parish map is available for this tutorial dataset.", {})],
    };
  }

  const result = buildRoadNetwork(inputMap);
  const traceGraph = result.traceGraph;
  const metadata = result.metadata;
  const frames = [
    frame("Select center parish", "The parish center closest to the middle of the map becomes the root of the road network.", {
      lots: inputMap.lots,
      routeGraph: traceGraph,
      parishCenters: inputMap.parishCenters,
      centerParishId: metadata.centerParishId,
      linkedParishIds: [metadata.centerParishId],
      roadRouteIds: [],
      bridgeNodeIds: [],
    }),
  ];
  const roadRouteIds = new Set();
  const bridgeNodeIds = new Set();
  const linkedParishIds = new Set([metadata.centerParishId]);

  (metadata.iterations || []).forEach((iteration, index) => {
    (iteration.routeIds || []).forEach((routeId) => roadRouteIds.add(routeId));
    (iteration.bridgeNodeIds || []).forEach((nodeId) => bridgeNodeIds.add(nodeId));
    linkedParishIds.add(iteration.parishId);
    frames.push(frame(
      `Link parish ${iteration.parishLetter || iteration.parishId}`,
      `Step ${index + 1} promotes the currently cheapest path from the center parish to ${iteration.parishName || "the next parish"}.`,
      {
        lots: inputMap.lots,
        routeGraph: traceGraph,
        parishCenters: inputMap.parishCenters,
        centerParishId: metadata.centerParishId,
        targetParishId: iteration.parishId,
        linkedParishIds: Array.from(linkedParishIds),
        currentRouteIds: iteration.routeIds || [],
        roadRouteIds: Array.from(roadRouteIds),
        bridgeNodeIds: Array.from(bridgeNodeIds),
      },
    ));
  });

  return {
    dataset,
    metadata,
    frames,
  };
}

function frame(title, body, geometry) {
  return { title, body, geometry };
}
