/*
 * WHAT: Correct obvious near-exclave assignments before field dispatch.
 * HOW: For each near-exclave lot, test reassignment to neighboring parishes in descending border-length order and accept the first move that reduces the number of near-exclaves.
 * WHY: This prevents obvious boundary flicker before lots subdivision while keeping field dispatch untouched.
 */

import {
  applyNearExclaveStateToLots,
  nearExclaveRatio,
  runNearExclaveStatistics,
} from "../near-exclave-metrics.js";
import { computeParishCenters } from "../2-2-group-lots/2-2-group-lots.js";

const STEP_LABEL = "Step 2.4 / Near-exclave corrections";

export function runNearExclaveCorrectionsStep(map) {
  const lots = map.lots || [];
  const segments = map.segments || [];
  if (!lots.length || !segments.length) {
    return {
      map,
      frameEntries: [{ label: STEP_LABEL, map }],
    };
  }

  let workingMap = map;
  let state = runNearExclaveStatistics(workingMap.lots || [], segments);
  let activeNearExclaveCount = state.nearExclaveLotCount || 0;
  let iterationsLeft = activeNearExclaveCount * 2;
  if (!iterationsLeft) {
    const nextLots = applyNearExclaveStateToLots(workingMap.lots || [], state.lotMetricsById);
    const parishCenters = recomputeParishCenters(workingMap, nextLots);
    return {
      map: {
        ...workingMap,
        lots: nextLots,
        parishCenters,
      },
      frameEntries: [{ label: STEP_LABEL, map: { ...workingMap, lots: nextLots, parishCenters } }],
    };
  }

  const parishMetadataById = buildParishMetadataById(workingMap.lots || []);
  const lotById = new Map((workingMap.lots || []).map((lot) => [lot.id, lot]));

  while (iterationsLeft > 0 && activeNearExclaveCount > 0) {
    const nearExclaveEntries = state.nearExclaveLotIds
      .map((lotId) => {
        const metric = state.lotMetricsById.get(lotId);
        const lot = lotById.get(lotId);
        return { lotId, lot, metric };
      })
      .filter(({ lot, metric }) => lot && metric)
      .sort((first, second) => {
        const firstRatio = nearExclaveRatio(first.metric);
        const secondRatio = nearExclaveRatio(second.metric);
        if (firstRatio !== secondRatio) {
          return secondRatio - firstRatio;
        }
        return first.lotId - second.lotId;
      });

    if (!nearExclaveEntries.length) {
      break;
    }

    let changedThisPass = false;
    for (const { lotId, lot, metric } of nearExclaveEntries) {
      if (iterationsLeft <= 0 || activeNearExclaveCount <= 0) {
        break;
      }

      const neighborEntries = Object.entries(metric.borderLengthByAdjacentParish || {})
        .map(([parishId, sharedBorderLength]) => ({
          parishId: Number(parishId),
          sharedBorderLength,
        }))
        .filter((entry) => entry.parishId !== lot.parishId && Number.isFinite(entry.sharedBorderLength))
        .sort((first, second) => {
          if (second.sharedBorderLength !== first.sharedBorderLength) {
            return second.sharedBorderLength - first.sharedBorderLength;
          }
          return first.parishId - second.parishId;
        });

      for (const neighbor of neighborEntries) {
        if (iterationsLeft <= 0) {
          break;
        }
        iterationsLeft -= 1;

        if (neighbor.parishId === lot.parishId) {
          continue;
        }

        const candidateLots = reassignLot(workingMap.lots || [], lot, neighbor.parishId, parishMetadataById);
        if (!candidateLots.length) {
          continue;
        }
        const candidateState = runNearExclaveStatistics(candidateLots, segments);
        const candidateCount = candidateState.nearExclaveLotCount || 0;
        if (candidateCount < activeNearExclaveCount) {
          workingMap = {
            ...workingMap,
            lots: candidateLots,
          };
          state = candidateState;
          lotById.set(lot.id, candidateLots.find((item) => item.id === lot.id));
          activeNearExclaveCount = candidateCount;
          changedThisPass = true;
          break;
        }
      }

      if (changedThisPass) {
        break;
      }
    }

    if (!changedThisPass) {
      break;
    }
  }

  const nextLots = applyNearExclaveStateToLots(workingMap.lots || [], state.lotMetricsById);
  const parishCenters = recomputeParishCenters(workingMap, nextLots);
  return {
    map: {
      ...workingMap,
      lots: nextLots,
      parishCenters,
    },
    frameEntries: [{ label: STEP_LABEL, map: { ...workingMap, lots: nextLots, parishCenters } }],
  };
}

function recomputeParishCenters(map, lots) {
  if (!Array.isArray(map.parishCenters) || !map.parishCenters.length || !map.routeGraph) {
    return map.parishCenters || [];
  }

  const nodesById = new Map((map.routeGraph.nodes || []).map((node) => [node.id, node]));
  const lotEntries = (map.routeGraph.nodes || [])
    .filter((node) => node.type === "lot_center" && node.lotId !== null && node.lotId !== undefined)
    .map((node) => ({
      lot: lots.find((lot) => lot.id === node.lotId),
      lotId: node.lotId,
      nodeId: node.id,
    }))
    .filter((entry) => entry.lot)
    .sort((first, second) => first.lotId - second.lotId);
  const centerNodeIds = map.parishCenters.map((center) => center.nodeId);
  return computeParishCenters({ lotEntries, nodesById }, lots, centerNodeIds, map.parishColors || []);
}

function reassignLot(lots, lot, nextParishId, parishMetadataById) {
  const metadata = parishMetadataById.get(nextParishId);
  if (!metadata) {
    return [];
  }
  const nextParishName = metadata.parish || metadata.parishName || "";
  return lots.map((item) => (item.id === lot.id ? {
    ...item,
    parishId: nextParishId,
    parishLetter: metadata.parishLetter ?? item.parishLetter,
    parishName: nextParishName || metadata.parishName || item.parishName,
    parish: nextParishName || item.parish,
  } : item));
}

function buildParishMetadataById(lots) {
  const byId = new Map();
  lots.forEach((lot) => {
    if (lot.parishId === null || lot.parishId === undefined) {
      return;
    }
    if (!byId.has(lot.parishId)) {
      byId.set(lot.parishId, {
        parishId: lot.parishId,
        parish: lot.parish || lot.parishName || "",
        parishName: lot.parishName || lot.parish || "",
        parishLetter: lot.parishLetter || null,
      });
    }
  });
  return byId;
}
