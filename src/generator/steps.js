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
