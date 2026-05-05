/*
 * WHAT: Run deterministic map generation off the main thread and stream progress back to the UI.
 * HOW: Execute one requested task at a time, posting step updates for single generation and sample counters for seed searches.
 * WHY: Heavy generation should not block pointer input, repaint, or form interaction in the browser.
 */

import { generateCity, generateCityThroughStep } from "./city-generator.js";
import { DEFAULT_SEGMENT_LENGTH } from "./map-model.js";

const RIVER_EVALUATION_STEP_INDEX = 6;

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }

  try {
    if (message.type === "generate") {
      await handleGenerateRequest(message);
      return;
    }

    if (message.type === "best-of-50") {
      await handleBestOfRequest(message);
    }
  } catch (error) {
    postMessage({
      type: "task-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

async function handleGenerateRequest({ requestId, options }) {
  const map = await generateCity(options, createGenerationStepTracker(requestId, options));

  postMessage({
    type: "generation-complete",
    requestId,
    map,
  });
}

async function handleBestOfRequest({ requestId, options, sampleCount, baseline }) {
  let bestCandidate = baseline
    ? {
      seed: baseline.seed,
      tributaryLength: baseline.tributaryLength,
      map: null,
      improved: false,
    }
    : null;

  postMessage({
    type: "best-of-start",
    requestId,
    sampleCount,
  });

  for (let index = 0; index < sampleCount; index += 1) {
    const seed = generateRandomSeed();
    const previewOptions = {
      ...options,
      seed,
    };
    const previewMap = await generateCityThroughStep(previewOptions, RIVER_EVALUATION_STEP_INDEX, createGenerationStepTracker(requestId, previewOptions));
    const tributaryLength = previewMap.rivers?.[1]?.length || 0;

    if (!bestCandidate || tributaryLength > bestCandidate.tributaryLength) {
      const candidateOptions = {
        ...options,
        seed,
      };
      const map = await generateCity(candidateOptions, createGenerationStepTracker(requestId, candidateOptions));
      bestCandidate = {
        seed,
        tributaryLength,
        map,
        improved: true,
      };
      postMessage({
        type: "best-of-better",
        requestId,
        completedCount: index + 1,
        sampleCount,
        seed,
        tributaryLength,
        map,
      });
    }

    postMessage({
      type: "best-of-progress",
      requestId,
      completedCount: index + 1,
      sampleCount,
    });
  }

  postMessage({
    type: "best-of-complete",
    requestId,
    sampleCount,
    seed: bestCandidate?.seed || null,
    tributaryLength: bestCandidate?.tributaryLength || 0,
    improved: bestCandidate?.improved === true,
    map: bestCandidate?.improved ? bestCandidate?.map || null : null,
  });
}

function getStepParametersForStep(stepIndex, options) {
  switch (stepIndex) {
    case 0:
      return {
        scatterAlgorithm: options.stepAlgorithms?.scatterPoints || "random_scattering",
        pointCount: options.pointCount,
        scatterPaddingRatio: options.scatterPaddingRatio,
        poissonSpacingRatio: options.poissonSpacingRatio,
        poissonMaxAttempts: options.poissonMaxAttempts,
        poissonPaddingRatio: options.poissonPaddingRatio,
      };
    case 1:
      return {
        pointCount: options.pointCount,
        mapSize: options.mapSize,
      };
    case 2:
      return {
        relaxPaddingRatio: options.relaxPaddingRatio,
      };
    case 3:
      return {
        segmentLength: DEFAULT_SEGMENT_LENGTH,
      };
    case 4:
      return {
        waterSides: options.waterSides.filter((side) => side.enabled).map((side) => side.name),
        waterReachRatio: options.waterReachRatio,
        waterExpansionBase: options.waterExpansionBase,
        waterExpansionEdgeWeight: options.waterExpansionEdgeWeight,
        waterPressureRangeRatio: options.waterPressureRangeRatio,
        waterCenterBiasRadiusRatio: options.waterCenterBiasRadiusRatio,
      };
    case 5:
      return {
        primaryRiverTurnAngleDegrees: options.primaryRiverTurnAngleDegrees,
      };
    case 6:
      return {
        tributaryRiverTurnAngleDegrees: options.tributaryRiverTurnAngleDegrees,
      };
    case 7:
      return {
        segmentLength: DEFAULT_SEGMENT_LENGTH,
      };
    case 8:
      return {
        segmentLength: DEFAULT_SEGMENT_LENGTH * 2,
      };
    case 9:
      return {
        segmentLength: DEFAULT_SEGMENT_LENGTH,
      };
    case 10:
      return {
        routeGraph: "segments",
      };
    case 11:
      return {
        parishAlgorithm: options.stepAlgorithms?.parishClustering || "euclidean_centroids",
        parishCount: options.parishCount,
      };
    case 12:
      return {
        tessellateAlgorithm: options.stepAlgorithms?.tessellateLots || "curved_bisection",
        minimumSplitChildAreaRatio: 0.4,
        curvedSplitCurve: "circular arc tangent to boundary-vertex bisectors",
        poissonVoronoiTargetSource: "estimated straight-bisection sublot count",
        splitSegmentLength: DEFAULT_SEGMENT_LENGTH * 0.5,
      };
    default:
      return null;
  }
}

function createGenerationStepTracker(requestId, options) {
  return {
    reset() {
      postMessage({
        type: "generation-reset",
        requestId,
      });
    },
    onStepStart(payload) {
      const params = {
        seed: options.seed,
        ...getStepParametersForStep(payload.index, options),
      };
      postMessage({
        type: "generation-step-start",
        requestId,
        ...payload,
        params,
      });
    },
    onStepComplete(payload) {
      postMessage({
        type: "generation-step-complete",
        requestId,
        ...payload,
      });
    },
    onStepProgress(payload) {
      postMessage({
        type: "generation-step-progress",
        requestId,
        ...payload,
      });
    },
    complete(payload) {
      postMessage({
        type: "generation-finished-steps",
        requestId,
        ...payload,
      });
    },
  };
}

function generateRandomSeed() {
  return Math.random().toString(36).slice(2, 10);
}
