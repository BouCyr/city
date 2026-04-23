/*
 * WHAT: Orchestrate the deterministic generation pipeline over the canonical map object.
 * HOW: Create the initial map, run each step module in order, and snapshot the updated map for replay.
 * WHY: The heavy lifting belongs inside the individual step modules, not in the pipeline coordinator.
 */

import { createSeededRandom } from "./random.js";
import { BLANK_STEP_INDEX, buildSummary, createFrame, createInitialMap, withStepMetadata } from "./map-model.js";
import { runBuildVoronoiStep } from "./step-build-voronoi.js";
import { runApplyWaterStep } from "./step-apply-water.js";
import { runFlagHillsStep } from "./step-flag-hills.js";
import { runRelaxPointsStep } from "./step-relax-points.js";
import { runScatterPointsStep } from "./step-scatter-points.js";
import { GENERATION_STEPS } from "./steps.js";

const GENERATION_PIPELINE = [
  { status: "Points", run: runScatterPointsStep },
  { status: "Voronoi", run: runBuildVoronoiStep },
  { status: "Water", run: runApplyWaterStep },
  { status: "Lloyd", run: runRelaxPointsStep },
  { status: "Hills", run: runFlagHillsStep },
];

export async function generateCity(options, stepTracker) {
  stepTracker.reset();

  const rng = createSeededRandom(options.seed);
  let map = createInitialMap(options);
  const frames = [createFrame("Blank map", null, BLANK_STEP_INDEX)];

  for (let index = 0; index < GENERATION_PIPELINE.length; index += 1) {
    const step = GENERATION_PIPELINE[index];
    const result = await stepTracker.advance(index, step.status, async () => step.run(map, { rng }));
    map = withStepMetadata(result.map, index, GENERATION_STEPS[index]);
    result.frameEntries.forEach((entry) => {
      frames.push(createFrame(entry.label, entry.map, index, GENERATION_STEPS[index]));
    });
  }

  stepTracker.complete();

  const finalMap = withStepMetadata(map, GENERATION_STEPS.length - 1, GENERATION_STEPS[GENERATION_STEPS.length - 1]);
  return {
    ...finalMap,
    summary: buildSummary(finalMap),
    steps: GENERATION_STEPS,
    frames,
  };
}
