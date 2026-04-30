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
        hillCount: options.hillCount,
        hillSeaDistance: options.hillSeaDistance,
        hillsideRadius: options.hillsideRadius,
      });
    case 6:
      return stableSignature({
        riverTurnAngle: options.riverTurnAngle,
        primaryRiverWidth: options.primaryRiverWidth,
      });
    case 7:
      return stableSignature({
        riverTurnAngle: options.riverTurnAngle,
        primaryRiverWidth: options.primaryRiverWidth,
        tributarySourceRiverDistance: options.tributarySourceRiverDistance,
        tributaryMergeSeaDistance: options.tributaryMergeSeaDistance,
        tributaryWidthRatio: options.tributaryWidthRatio,
        primaryMergeWidthGain: options.primaryMergeWidthGain,
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
        tessellateAlgorithm: options.stepAlgorithms?.tessellateLots || "straight_bisection",
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
