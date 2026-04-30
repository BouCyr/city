/*
 * WHAT: Orchestrate the deterministic generation pipeline over the canonical map object.
 * HOW: Create the initial map, run each step module in order, and snapshot the updated map for replay.
 * WHY: The heavy lifting belongs inside the individual step modules, not in the pipeline coordinator.
 */

import { createSeededRandom } from "./random.js";
import { BLANK_STEP_INDEX, createFrame, createInitialMap, withStepMetadata } from "./map-model.js";
import { runBuildVoronoiStep } from "./1-2-build-voronoi/1-2-build-voronoi.js";
import { runApplyWaterStep } from "./1-5-apply-water/1-5-apply-water.js";
import { runFlagHillsStep } from "./1-6-flag-hills/1-6-flag-hills.js";
import { runFirstRiverStep } from "./1-7-first-river/1-7-first-river.js";
import { runFirstTributaryStep } from "./1-8-first-tributary/1-8-first-tributary.js";
import { runConvertLotsStep } from "./1-9-convert-lots/1-9-convert-lots.js";
import { runAddRiversToLotGeometryStep } from "./1-10-add-rivers-to-lot-geometry/1-10-add-rivers-to-lot-geometry.js";
import { runTessellateLotsStep } from "./1-11-tessellate-lots/1-11-tessellate-lots.js";
import { runRelaxPointsStep } from "./1-3-relax-points/1-3-relax-points.js";
import { runScatterPointsStep } from "./1-1-scatter-points/1-1-scatter-points.js";
import { runCollapseShortEdgesStep } from "./1-4-collapse-short-edges/1-4-collapse-short-edges.js";
import { GENERATION_STEPS } from "./steps.js";

const GENERATION_PIPELINE = [
  { status: "Points", run: runScatterPointsStep },
  { status: "Voronoi", run: runBuildVoronoiStep },
  { status: "Lloyd", run: runRelaxPointsStep },
  { status: "Simplify", run: runCollapseShortEdgesStep },
  { status: "Water", run: runApplyWaterStep },
  { status: "Hills", run: runFlagHillsStep },
  { status: "River", run: runFirstRiverStep },
  { status: "Tributary", run: runFirstTributaryStep },
  { status: "Lots", run: runConvertLotsStep },
  { status: "River Lots", run: runAddRiversToLotGeometryStep },
  { status: "Tessellation", run: runTessellateLotsStep },
];

export async function generateCity(options, stepTracker) {
  return runGenerationPipeline(options, stepTracker);
}

export async function generateCityThroughStep(options, endStepIndex, stepTracker) {
  return runGenerationPipeline(options, stepTracker, {
    endStepIndex,
  });
}

async function runGenerationPipeline(options, stepTracker, { endStepIndex = GENERATION_PIPELINE.length - 1 } = {}) {
  stepTracker?.reset?.();

  const rng = createSeededRandom(options.seed);
  let map = createInitialMap(options);
  const frames = [createFrame("Blank map", null, BLANK_STEP_INDEX)];
  const stepDurations = [];

  const lastStepIndex = Math.min(endStepIndex, GENERATION_PIPELINE.length - 1);
  for (let index = 0; index <= lastStepIndex; index += 1) {
    const step = GENERATION_PIPELINE[index];
    stepTracker?.onStepStart?.({
      index,
      status: step.status,
      label: GENERATION_STEPS[index],
    });
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const result = await step.run(map, { rng });
    const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const durationMs = finishedAt - startedAt;
    stepDurations[index] = durationMs;
    map = withStepMetadata(result.map, index, GENERATION_STEPS[index]);
    const createdFrames = result.frameEntries.map((entry) =>
      createFrame(entry.label, entry.map, index, GENERATION_STEPS[index])
    );
    createdFrames.forEach((frame) => {
      frames.push(frame);
    });
    stepTracker?.onStepComplete?.({
      index,
      status: step.status,
      label: GENERATION_STEPS[index],
      durationMs,
      frame: createdFrames.at(-1) || createFrame(GENERATION_STEPS[index], map, index, GENERATION_STEPS[index]),
      stepDurations: [...stepDurations],
    });
  }

  if (lastStepIndex === GENERATION_PIPELINE.length - 1) {
    stepTracker?.complete?.({
      stepDurations: [...stepDurations],
    });
  }

  const finalStepIndex = Math.max(0, lastStepIndex);
  const finalMap = withStepMetadata(map, finalStepIndex, GENERATION_STEPS[finalStepIndex]);
  return {
    ...finalMap,
    steps: GENERATION_STEPS,
    frames,
    stepDurations,
  };
}
