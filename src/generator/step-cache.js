/*
 * WHAT: Define deterministic step signatures for incremental generation reuse.
 * HOW: Hash only the inputs that can affect each step's output.
 * WHY: Shared signatures let the worker cache and the UI agree on the earliest changed step.
 */

export function buildGenerationStepSignature(stepIndex, options) {
  switch (stepIndex) {
    case 0:
      return stableSignature({
        seed: options.seed,
        scatterAlgorithm: options.stepAlgorithms?.scatterPoints || "random_scattering",
        pointCount: options.pointCount,
        scatterPaddingRatio: options.scatterPaddingRatio,
        poissonSpacingRatio: options.poissonSpacingRatio,
        poissonMaxAttempts: options.poissonMaxAttempts,
        poissonPaddingRatio: options.poissonPaddingRatio,
        mapSize: options.mapSize,
      });
    case 1:
      return stableSignature({
        mapSize: options.mapSize,
      });
    case 2:
      return stableSignature({
        relaxPaddingRatio: options.relaxPaddingRatio,
      });
    case 3:
      return stableSignature({
        segmentLength: "default",
      });
    case 4:
      return stableSignature({
        waterSides: (options.waterSides || []).filter((side) => side.enabled).map((side) => side.name),
        waterReachRatio: options.waterReachRatio,
        waterExpansionBase: options.waterExpansionBase,
        waterExpansionEdgeWeight: options.waterExpansionEdgeWeight,
        waterPressureRangeRatio: options.waterPressureRangeRatio,
        waterCenterBiasRadiusRatio: options.waterCenterBiasRadiusRatio,
      });
    case 5:
      return stableSignature({
        primaryRiverWidth: options.primaryRiverWidth,
        primaryRiverTurnAngleDegrees: options.primaryRiverTurnAngleDegrees,
      });
    case 6:
      return stableSignature({
        primaryRiverWidth: options.primaryRiverWidth,
        tributaryWidthRatio: options.tributaryWidthRatio,
        primaryMergeWidthGain: options.primaryMergeWidthGain,
        tributaryRiverTurnAngleDegrees: options.tributaryRiverTurnAngleDegrees,
      });
    case 7:
      return stableSignature({
        segmentLength: "default",
      });
    case 8:
      return stableSignature({
        segmentLength: "default",
      });
    case 9:
      return stableSignature({
        routeGraph: "segments",
      });
    case 10:
      return stableSignature({
        parishAlgorithm: options.stepAlgorithms?.parishClustering || "graph_kmeans",
        parishCount: options.parishCount,
        routeCrossingCost: options.routeCrossingCost,
        routeDistanceModel: "center-node-road-x3-alley-x6-plus-crossing-cost",
      });
    case 11:
      return stableSignature({
        routeGraph: "parish-center-road-network",
        routeCrossingCost: options.routeCrossingCost,
        bridgePenaltyMultiplier: 1.5,
      });
    case 12:
      return stableSignature({
        segmentLength: "default",
        routeGraph: "rebuilt-after-land-edge-and-parish-border-smoothing",
        parishBorderSmoothing: "quadratic-pinned-same-pair-chains",
      });
    case 13:
      return stableSignature({
        tessellateAlgorithm: options.stepAlgorithms?.tessellateLots || "curved_bisection",
        splitSegmentLength: "default",
      });
    default:
      return "";
  }
}

export function findFirstChangedGenerationStep(previousOptions, nextOptions, totalSteps) {
  if (!previousOptions) {
    return 0;
  }

  for (let index = 0; index < totalSteps; index += 1) {
    if (buildGenerationStepSignature(index, previousOptions) !== buildGenerationStepSignature(index, nextOptions)) {
      return index;
    }
  }

  return null;
}

function stableSignature(value) {
  return JSON.stringify(value);
}
