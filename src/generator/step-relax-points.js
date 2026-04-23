/*
 * WHAT: Apply one Lloyd relaxation pass, rebuild the Voronoi geometry, and reclassify water.
 * HOW: Move non-protected sites to their cell centroids, rebuild canonical cells/edges, then rerun the water step.
 * WHY: Smoothed geometry is still a core generation step, but it must preserve the current coast-building rules.
 */

import { buildVoronoiDiagram } from "../lib/voronoi-client.js";
import { clamp } from "./geometry.js";
import { buildCanonicalGeometry } from "./map-model.js";
import { applyWaterClassification } from "./step-apply-water.js";

const RELAX_PADDING_RATIO = 0.04;

export function runRelaxPointsStep(map, { rng }) {
  const padding = map.meta.size * RELAX_PADDING_RATIO;
  const protectedCellIds = collectProtectedCellIds(map);
  const points = map.cells.map((cell) => ({
    id: cell.site.id ?? cell.id,
    x: protectedCellIds.has(cell.id) ? cell.site.x : clamp(cell.centroid.x, padding, map.meta.size - padding),
    y: protectedCellIds.has(cell.id) ? cell.site.y : clamp(cell.centroid.y, padding, map.meta.size - padding),
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
    cityCenterCellId: null,
  };
  const nextMap = applyWaterClassification(rebuiltMap, rng);

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 4 / Lloyd-smoothed map",
        map: nextMap,
      },
    ],
  };
}

function collectProtectedCellIds(map) {
  const protectedCellIds = new Set();
  const boundaryCellIds = new Set(
    map.cells
      .filter((cell) => cell.features.boundary)
      .map((cell) => cell.id),
  );

  boundaryCellIds.forEach((cellId) => {
    protectedCellIds.add(cellId);
  });

  map.cells.forEach((cell) => {
    if (cell.neighborCellIds.some((neighborId) => boundaryCellIds.has(neighborId))) {
      protectedCellIds.add(cell.id);
    }
  });

  return protectedCellIds;
}
