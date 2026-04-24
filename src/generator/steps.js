/*
 * WHAT: Define the canonical top-level generation steps shown in replay and status UI.
 * HOW: Export one ordered label list that both the generator and step tracker read directly.
 * WHY: Keeping the labels in one module prevents the UI and generation pipeline from drifting apart.
 */

export const GENERATION_STEPS = [
  "Scatter pseudo-random points",
  "Compute Voronoi cells and edges",
  "Select and paint sea areas",
  "Apply one Lloyd relaxation pass",
  "Flag inland hill cells",
  "Trace the first river",
  "Trace the first tributary",
];

export const GENERATION_STEP_TREE = [
  {
    label: "Geographical feature",
    stepIndices: GENERATION_STEPS.map((_, index) => index),
  },
  {
    label: "Human usage",
    stepIndices: [],
  },
];
