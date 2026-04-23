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

5. Choose the city center cell.
From the non-sea cells, select the cell that is farthest from every land side. The chosen center cell is highlighted with a light red fill.

6. Trace river channels.
Starting from inland land cells that are not too close to the sea, trace each river cell-by-cell toward the sea through shared-edge midpoints. Rivers are generated one by one, are slightly attracted to previously traced rivers, stop when they reach the sea or another river, and are drawn as dark blue lines.
