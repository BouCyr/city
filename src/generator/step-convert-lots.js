/*
 * WHAT: Convert the final Voronoi cell map into the canonical lot-and-segment geometry.
 * HOW: Repackage every cell as a lot, resample each boundary edge into ~5px segments, and drop the old cell/edge arrays.
 * WHY: Later replay, hover, and rendering should work from the same segment-based model the user now sees.
 */

import { DEFAULT_SEGMENT_LENGTH, convertCellGeometryToLotGeometry } from "./map-model.js";

export function runConvertLotsStep(map) {
  const nextMap = convertCellGeometryToLotGeometry(map, DEFAULT_SEGMENT_LENGTH);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.9 / Convert to lot geometry",
        map: nextMap,
      },
    ],
  };
}
