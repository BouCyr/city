/*
 * WHAT: Apply one Lloyd relaxation pass and rebuild the Voronoi geometry.
 * HOW: Move non-protected sites to their cell centroids, then rebuild canonical cells and edges.
 * WHY: Smoothing geometry should happen before coastline classification so later simplification works on land-neutral cells.
 */

import { buildVoronoiDiagram } from "../../lib/voronoi-client.js";
import { clamp } from "../geometry.js";
import { buildCanonicalGeometry } from "../map-model.js";

export function runRelaxPointsStep(map) {
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
  const nextMap = {
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

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.3 / Lloyd-smoothed map",
        map: nextMap,
      },
    ],
  };
}
