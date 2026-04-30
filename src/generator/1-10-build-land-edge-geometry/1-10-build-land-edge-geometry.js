/*
 * WHAT: Normalize the remaining lot geometry after coastline conversion.
 * HOW: Keep pure sea edges intact and resample every other edge into straight segments.
 * WHY: Downstream lot processing expects a stable segment-only geometry with shared vertices deduped.
 */

import { DEFAULT_SEGMENT_LENGTH, convertLotGeometryToLandEdgeGeometry } from "../map-model.js";

export function runBuildLandEdgeGeometryStep(map) {
  const nextMap = convertLotGeometryToLandEdgeGeometry(map, DEFAULT_SEGMENT_LENGTH * 2);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.10 / Build land-edge geometry",
        map: nextMap,
      },
    ],
  };
}
