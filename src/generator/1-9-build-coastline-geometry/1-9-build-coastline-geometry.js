/*
 * WHAT: Turn cell geometry into the initial coastline-aware lot geometry.
 * HOW: Convert Voronoi cells to lots, then curve sea-facing boundaries into short sampled segments.
 * WHY: Coastlines need denser geometry before the later land-edge resampling pass.
 */

import { DEFAULT_SEGMENT_LENGTH, convertCellGeometryToCoastlineLotGeometry } from "../map-model.js";

export function runBuildCoastlineGeometryStep(map) {
  const nextMap = convertCellGeometryToCoastlineLotGeometry(map, DEFAULT_SEGMENT_LENGTH);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.9 / Build coastline geometry",
        map: nextMap,
      },
    ],
  };
}
