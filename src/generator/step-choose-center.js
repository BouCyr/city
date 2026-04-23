/*
 * WHAT: Choose and mark the city center cell on the canonical map.
 * HOW: Prefer the land cell farthest from land sides, or the most central land cell when every side is water.
 * WHY: The center step should only update a small feature flag and a single id.
 */

import { distanceFromCenter, distanceToSide } from "./geometry.js";

export function runChooseCenterStep(map) {
  const cityCenterCellId = chooseCityCenterCell(map);
  const cells = map.cells.map((cell) => ({
    ...cell,
    features: {
      ...cell.features,
      cityCenter: cell.id === cityCenterCellId,
    },
  }));
  const nextMap = {
    ...map,
    cells,
    cityCenterCellId,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 5 / City center",
        map: nextMap,
      },
    ],
  };
}

function chooseCityCenterCell(map) {
  const landSides = map.init.params.waterSides
    .filter((side) => !side.enabled)
    .map((side) => side.name);
  const candidates = map.cells.filter((cell) => !cell.features.sea);

  if (!candidates.length) {
    return null;
  }

  if (!landSides.length) {
    return candidates.reduce((best, cell) => {
      const score = distanceFromCenter(cell.centroid, map.meta.size);
      if (!best || score < best.score) {
        return { id: cell.id, score };
      }
      return best;
    }, null)?.id ?? null;
  }

  return candidates.reduce((best, cell) => {
    const score = Math.min(...landSides.map((side) => distanceToSide(cell.centroid, map.meta.size, side)));
    if (!best || score > best.score) {
      return { id: cell.id, score };
    }
    return best;
  }, null)?.id ?? null;
}
