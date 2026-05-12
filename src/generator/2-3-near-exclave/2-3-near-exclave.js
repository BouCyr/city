/*
 * WHAT: Identify lots that border many foreign parishes at step 2.3.
 * HOW: Reuse the shared near-exclave metric pass to compute border lengths and segment counts.
 * WHY: This catches near-exclave candidates before field dispatch, and preserves the result for later rendering/debug steps.
 */
import { applyNearExclaveStateToLots, nearExclaveStepLabel, runNearExclaveStatistics } from "../near-exclave-metrics.js";

export function runNearExclaveLotsStep(map) {
  const lots = map.lots || []
  const segments = map.segments || []
  const { lotMetricsById } = runNearExclaveStatistics(lots, segments)

  const nextLots = applyNearExclaveStateToLots(lots, lotMetricsById)

  return {
    map: {
      ...map,
      lots: nextLots,
    },
    frameEntries: [{ label: nearExclaveStepLabel(), map: { ...map, lots: nextLots } }],
  };
}
