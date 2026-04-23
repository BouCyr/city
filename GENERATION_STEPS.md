# Generation Steps

Keep this file aligned with `src/generator/steps.js`.

1. Scatter pseudo-random points.
The app places the user-selected number of points across the canvas using the seeded random stream.

2. Compute Voronoi cells and edges.
The point field is converted into Voronoi polygons and adjacency edges. Both cells and edges are exposed as clean data structures for later map logic.

3. Select and paint sea areas.
Cells touching the selected outer sides seed the sea, then pseudo-random flood expansion pushes water inland. Cells farther than 20% of the field size from every selected water side stay land. Sea cells are filled blue, regular edges stay dark, and edges between sea cells are drawn dark blue.

4. Apply one Lloyd relaxation pass.
Each site is moved once to the centroid of its current Voronoi cell, the diagram is rebuilt, and water selection is recomputed on the smoothed cells.

5. Flag inland hill cells.
Select land cells that are at least four cell-to-cell steps away from the sea. The first hill is chosen randomly from the valid inland land cells, then each later hill greedily picks the valid candidate that is farthest from the already chosen hills.

6. Trace the first river.
Evaluate one-side boundary land cells as possible sources, compute each cell's shortest land path to the sea cell nearest the geometric center, and keep the longest resulting path. The river is drawn from the boundary side toward the sea with a deterministic name.

7. Trace the first tributary.
Evaluate more one-side boundary land cells, route them with the same land-path rules, and keep the longest path that merges into the existing river at least five cells upstream from the outlet.
