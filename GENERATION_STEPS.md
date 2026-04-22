# Generation Steps

Keep this file aligned with `src/generator/steps.js`.

1. Scatter pseudo-random points.
The app places the user-selected number of points across the canvas using the seeded random stream.

2. Compute Voronoi cells and edges.
The point field is converted into Voronoi polygons and adjacency edges. Both cells and edges are exposed as clean data structures for later map logic.

3. Select and paint sea areas.
Cells touching the selected outer sides seed the sea, then pseudo-random flood expansion pushes water inland. Sea cells are filled blue, regular edges stay dark, and edges between sea cells are drawn dark blue.
