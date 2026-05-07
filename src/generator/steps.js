/*
 * WHAT: Define the canonical top-level generation steps shown in replay and status UI.
 * HOW: Export one ordered label list that both the generator and step tracker read directly.
 * WHY: Keeping the labels in one module prevents the UI and generation pipeline from drifting apart.
 */

export const GENERATION_STEPS = [
  "Point cloud",
  "Voronoi cells",
  "Relaxed cells",
  "Collapsed edges",
  "Sea mask",
  "Noise",
  "Primary river",
  "River branch",
  "Coastline mesh",
  "River splits",
  "Route graph",
  "Parish clustering",
  "Road network",
  "Parish borders",
  "Land edges segmentation",
  "Field dispatch",
];

export const GENERATION_STEP_TREE = [
  {
    label: "Geographical features",
    stepIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
  {
    label: "Human occupation",
    stepIndices: [10, 11, 12, 13, 14, 15],
  },
];
