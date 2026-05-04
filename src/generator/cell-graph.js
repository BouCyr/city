/*
 * WHAT: Share graph traversal helpers for cell-based generation steps.
 * HOW: Export small functions that operate on canonical cells and cell id lists.
 * WHY: Terrain and river steps need graph distances without owning traversal details.
 */

export function computeCellDistances(cells, sourceCellIds) {
  const distances = Array.from({ length: cells.length }, () => Infinity);
  const queue = [];

  sourceCellIds.forEach((cellId) => {
    distances[cellId] = 0;
    queue.push(cellId);
  });

  for (let index = 0; index < queue.length; index += 1) {
    const cellId = queue[index];
    const distance = distances[cellId];
    const cell = cells[cellId];
    if (!cell) {
      continue;
    }

    cell.neighborCellIds.forEach((neighborId) => {
      if (distance + 1 >= distances[neighborId]) {
        return;
      }

      distances[neighborId] = distance + 1;
      queue.push(neighborId);
    });
  }

  return distances;
}
