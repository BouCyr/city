/*
 * WHAT: Convert scattered points into canonical Voronoi cells and edges.
 * HOW: Build the raw diagram through the d3 wrapper, then normalize it into the canonical map model.
 * WHY: Later steps should operate on cells and edges, not library-specific Voronoi internals.
 */

import { buildVoronoiDiagram } from "../lib/voronoi-client.js";
import { buildCanonicalGeometry } from "./map-model.js";

export function runBuildVoronoiStep(map) {
  const diagram = buildVoronoiDiagram({
    points: map.points,
    width: map.meta.size,
    height: map.meta.size,
  });
  const geometry = buildCanonicalGeometry(diagram);
  const nextMap = {
    ...map,
    ...geometry,
    water: {
      sides: [],
      seaCellIds: [],
    },
    cityCenterCellId: null,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 2 / Raw Voronoi diagram",
        map: nextMap,
      },
    ],
  };
}
