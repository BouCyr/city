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
        collapseShortEdgeLength: options.collapseShortEdgeLength ?? 35,
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
        noiseMinimumEdgeLength: 100,
        noiseMinDisplacementRatio: options.noiseMinDisplacementRatio ?? 0.1,
        noiseMaxDisplacementRatio: options.noiseMaxDisplacementRatio ?? 0.2,
      });
    case 6:
      return stableSignature({
        primaryRiverWidth: options.primaryRiverWidth,
        primaryRiverTurnAngleDegrees: options.primaryRiverTurnAngleDegrees,
      });
    case 7:
      return stableSignature({
        primaryRiverWidth: options.primaryRiverWidth,
        tributaryWidthRatio: options.tributaryWidthRatio,
        primaryMergeWidthGain: options.primaryMergeWidthGain,
        tributaryRiverTurnAngleDegrees: options.tributaryRiverTurnAngleDegrees,
      });
    case 8:
      return stableSignature({
        segmentLength: "default",
      });
    case 9:
      return stableSignature({
        segmentLength: "default",
      });
    case 10:
      return stableSignature({
        routeGraph: "segments",
      });
    case 11:
      return stableSignature({
        parishAlgorithm: options.stepAlgorithms?.parishClustering || "route_growth",
        parishCount: options.parishCount,
        routeCrossingCost: options.routeCrossingCost,
        routeDistanceModel: "center-node-road-x3-alley-x6-plus-crossing-cost",
      });
    case 12:
      return stableSignature({
      });
    case 13:
      return stableSignature({
      });
    case 14:
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
