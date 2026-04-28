/*
 * WHAT: Apply one Lloyd relaxation pass, rebuild the Voronoi geometry, and reclassify water.
 * HOW: Move non-protected sites to their cell centroids, rebuild canonical cells/edges, then rerun the water step.
 * WHY: Smoothed geometry is still a core generation step, but it must preserve the current coast-building rules.
 */

import { buildVoronoiDiagram } from "../lib/voronoi-client.js";
import { clamp } from "./geometry.js";
import { buildCanonicalGeometry } from "./map-model.js";
import { applyWaterClassification } from "./step-apply-water.js";

export function runRelaxPointsStep(map, { rng }) {
  const padding = map.meta.size * (map.init.params.relaxPaddingRatio ?? 0.04);
  const points = map.cells.map((cell) => ({
    id: cell.site.id ?? cell.id,
    x: cell.features.boundary ? cell.site.x : clamp(cell.centroid.x, padding, map.meta.size - padding),
    y: cell.features.boundary ? cell.site.y : clamp(cell.centroid.y, padding, map.meta.size - padding),
  }));

  const diagram = buildVoronoiDiagram({
    points,
    width: map.meta.size,
    height: map.meta.size,
  });
  const geometry = buildCanonicalGeometry(diagram);
  const rebuiltMap = {
    ...map,
    points,
    ...geometry,
    rivers: [],
    river: {
      primary: null,
      secondary: null,
    },
    cityCenterCellId: null,
  };
  const nextMap = applyWaterClassification(rebuiltMap, rng);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.4 / Lloyd-smoothed map",
        map: nextMap,
      },
    ],
  };
}
