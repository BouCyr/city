/*
 * WHAT: Flag a spaced-out set of inland land cells as hills.
 * HOW: Keep only land cells at least four graph steps from the sea, pick one random seed hill, then greedily add hills
 *      by maximizing graph distance from the existing hill set.
 * WHY: Hills should form a distinct inland belt, and the surrounding slopes should read as a secondary terrain zone.
 */

export function runFlagHillsStep(map, { rng }) {
  const hillCellIds = chooseHillCells(map, rng, map.init.params.hillCount ?? 0);
  const hillIds = new Set(hillCellIds);
  const hillsideIds = collectHillsides(map, hillCellIds);
  const cells = map.cells.map((cell) => ({
    ...cell,
    features: {
      ...cell.features,
      hill: hillIds.has(cell.id),
      hillside: hillsideIds.has(cell.id),
    },
  }));
  const nextMap = {
    ...map,
    cells,
  };

  return {
    map: nextMap,
    frameEntries: [
      {
        label: "Step 1.5 / Inland hill cells",
        map: nextMap,
      },
    ],
  };
}

function chooseHillCells(map, rng, targetCount) {
  const normalizedTarget = Math.max(0, Math.floor(targetCount));
  if (normalizedTarget === 0 || map.cells.length === 0) {
    return [];
  }

  const seaDistances = computeCellDistances(map, map.cells.filter((cell) => cell.features.sea).map((cell) => cell.id));
  const hillSeaDistance = map.init.params.hillSeaDistance ?? 4;
  const candidates = map.cells.filter((cell) => cell.features.land && seaDistances[cell.id] >= hillSeaDistance);
  if (!candidates.length) {
    return [];
  }

  const selectedIds = [rng.pick(candidates).id];

  while (selectedIds.length < normalizedTarget && selectedIds.length < candidates.length) {
    const selectedSet = new Set(selectedIds);
    const hillDistances = computeCellDistances(map, selectedIds);
    const remainingCandidates = candidates.filter((cell) => !selectedSet.has(cell.id));
    if (!remainingCandidates.length) {
      break;
    }

    let bestCandidate = remainingCandidates[0];
    let bestScore = hillDistances[bestCandidate.id];
    let bestSeaDistance = seaDistances[bestCandidate.id];

    remainingCandidates.slice(1).forEach((candidate) => {
      const candidateScore = hillDistances[candidate.id];
      const candidateSeaDistance = seaDistances[candidate.id];
      if (candidateScore > bestScore) {
        bestCandidate = candidate;
        bestScore = candidateScore;
        bestSeaDistance = candidateSeaDistance;
        return;
      }

      if (candidateScore === bestScore && candidateSeaDistance > bestSeaDistance) {
        bestCandidate = candidate;
        bestSeaDistance = candidateSeaDistance;
        return;
      }

      if (candidateScore === bestScore && candidateSeaDistance === bestSeaDistance && candidate.id < bestCandidate.id) {
        bestCandidate = candidate;
      }
    });

    selectedIds.push(bestCandidate.id);
  }

  return selectedIds;
}

function collectHillsides(map, hillCellIds) {
  if (!hillCellIds.length) {
    return new Set();
  }

  const hillsideRadius = map.init.params.hillsideRadius ?? 2;
  const hillDistances = computeCellDistances(map, hillCellIds);
  return new Set(
    map.cells
      .filter((cell) => cell.features.land && hillDistances[cell.id] > 0 && hillDistances[cell.id] <= hillsideRadius)
      .map((cell) => cell.id),
  );
}

function computeCellDistances(map, sourceCellIds) {
  const distances = Array.from({ length: map.cells.length }, () => Infinity);
  const queue = [];

  sourceCellIds.forEach((cellId) => {
    distances[cellId] = 0;
    queue.push(cellId);
  });

  for (let index = 0; index < queue.length; index += 1) {
    const cellId = queue[index];
    const distance = distances[cellId];
    const cell = map.cells[cellId];
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
