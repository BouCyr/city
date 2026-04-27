# Generation Steps

This file is the human-readable spec for the implemented generation pipeline.

It must stay aligned with:
- `src/generator/steps.js`
- `src/generator/city-generator.js`
- the step modules under `src/generator/`
- shared river-path constraints in `src/generator/river-path.js`

If generation rules change, update this file in the same change.

## Canonical Order

1. Geographical feature
1.1 Scatter pseudo-random points
1.2 Compute Voronoi cells and edges
1.3 Select and paint sea areas
1.4 Apply one Lloyd relaxation pass
1.5 Flag inland hill cells
1.6 Trace the first river
1.7 Trace the first tributary
1.8 Convert to lot geometry
1.9 Add rivers to lot geometry
1.10 Tessellate lot geometry
2. Human usage

Notes:
- The current implemented generation pipeline only executes the `Geographical feature` branch.
- `Human usage` is a reserved root step in the UI tree and is currently empty.

## Shared Data Rules

- The generator operates on one canonical `map` object.
- User-facing generation controls are grouped in collapsible UI sections:
  - one root group for `Geographical Feature Controls`
  - one root group for `Human Usage Controls`
  - nested subgroups per implemented generation step
- Cells expose, through step 1.7:
  - `id`
  - `site`
  - `centroid`
  - `polygon`
  - `edgeIds`
  - `neighborCellIds`
  - `boundarySides`
  - `features`
- Cell `features` currently include:
  - `land`
  - `sea`
  - `hill`
  - `hillside`
  - `river`
  - `boundary`
  - `cityCenter`
- Lots expose, from step 1.8 onward:
  - `id`
  - `site`
  - `centroid`
  - `polygon`
  - `segmentIds`
  - `neighborLotIds`
  - `boundarySides`
  - `features`
- Lot `features` preserve cell flags except temporary hill and hillside flags, which are cleared after step 1.7.
- Segments expose:
  - `id`
  - `from`
  - `to`
  - `midpoint`
  - `length`
  - `leftLotId`
  - `rightLotId`
  - `features`
- From step 1.9 onward, river/lot crossing points are shared between lot polygons and river-derived segments.
- From step 1.10 onward, `map.tessellation` exposes shared mesh vertices and Voronoi sublots.
- Cell and lot adjacency are derived from real clipped Voronoi shared edges, not directly from raw Delaunay neighbors.

## 1. Scatter Pseudo-Random Points

Source: `src/generator/step-scatter-points.js`

Business rules:
- The seeded RNG is the only source of randomness for point placement.
- `pointCount` points are created.
- Points are not allowed to lie directly on the map border.
- The scatter padding ratio is user-controlled.
- Default scatter padding ratio is `0.01`.
- Allowed scatter padding ratio range is `0` to `0.1`.
- Point ids are sequential and stable from `0` to `pointCount - 1`.

State effects:
- Replaces `map.points`.
- Clears previous `cells`, `edges`, `rivers`, `water`, and city-center state.

## 2. Compute Voronoi Cells And Edges

Source:
- `src/generator/step-build-voronoi.js`
- `src/lib/voronoi-client.js`
- `src/generator/map-model.js`

Business rules:
- The Voronoi diagram is clipped to the rectangular map bounds.
- Cell polygons are sanitized and deduplicated.
- Cell centroids are computed from polygon area when possible.
- Boundary touch detection is geometric and uses the clipped polygon.
- Edge boundary classification is geometric and tied to the canvas border.
- Canonical adjacency only exists when two cells share a real in-bounds edge.
- Boundary edges have one real adjacent cell and one outside side.

State effects:
- Builds canonical `cells` and `edges`.
- Resets `rivers`.
- Resets `water`.

## 3. Select And Paint Sea Areas

Source: `src/generator/step-apply-water.js`

Business rules:
- Only user-enabled outer sides may seed water.
- Water behavior is user-configurable through:
  - water reach ratio
  - water expansion base
  - water edge weight
  - water pressure range ratio
  - water center-bias radius ratio
- Water seeding starts from cells touching enabled sides.
- A cell is seed-eligible only if it lies within the configured water reach ratio of map size from at least one enabled water side.
- Water then expands by graph flood through cell neighbors.
- Expansion is probabilistic, not purely deterministic by distance.
- Expansion probability is influenced by:
  - the configured water expansion base
  - stronger pressure near enabled water sides scaled by the configured water edge weight
  - resistance toward the center of the map scaled by the configured center-bias radius
- If no water sides are enabled, no sea is created.
- An edge is marked `sea` only when both adjacent cells are sea.

Default values:
- water reach ratio: `0.2`
- water expansion base: `0.14`
- water edge weight: `0.52`
- water pressure range ratio: `0.42`
- water center-bias radius ratio: `0.68`

State effects:
- Sets cell `features.sea` and `features.land`.
- Sets edge `features.sea`.
- Stores `water.sides`.
- Stores `water.seaCellIds`.

## 4. Apply One Lloyd Relaxation Pass

Source: `src/generator/step-relax-points.js`

Business rules:
- Exactly one Lloyd pass is applied.
- Boundary sites stay fixed.
- Non-boundary sites move to their current cell centroids.
- Relaxed points are clamped away from the border with a user-controlled padding ratio.
- Default relax padding ratio is `0.04`.
- Allowed relax padding ratio range is `0` to `0.15`.
- After rebuilding the geometry, sea classification is recomputed from scratch.

State effects:
- Replaces `points`, `cells`, and `edges`.
- Clears `rivers`.
- Reapplies water.

## 5. Flag Inland Hill Cells

Source: `src/generator/step-flag-hills.js`

Business rules:
- Hill placement uses graph distance in cells, not Euclidean distance.
- Hill behavior is user-configurable through:
  - hill count
  - hill sea distance
  - hillside radius
- A hill candidate must:
  - be `land`
  - be at least the configured hill sea distance away from the sea
- The first hill is chosen pseudo-randomly from the valid candidate set.
- Each later hill is chosen greedily to maximize graph distance from already selected hills.
- Tie-breaks for later hills are:
  - larger distance from existing hills
  - then larger sea distance
  - then lower cell id
- If there are no valid hill candidates, no hills are placed.
- `hillCount` is an upper bound, not a guarantee.
- `hillside` cells are all land cells within graph distance `1` up to the configured hillside radius from any hill.
- Hillsides exclude the hill cells themselves.

Default values:
- hill count: `15`
- hill sea distance: `4`
- hillside radius: `2`

State effects:
- Sets cell `features.hill`.
- Sets cell `features.hillside`.

## 6. Trace The First River

Source:
- `src/generator/step-first-river.js`
- `src/generator/river-path.js`

Source-cell rules:
- The river source cell must:
  - be `land`
  - not be `hill`
  - not be `hillside`
  - touch exactly one map side
- Corner cells are excluded because they touch more than one side.
- The source point is the midpoint of a boundary edge on that source side.

Path target rules:
- Normal case:
  - target the sea cell whose centroid is closest to the geometric center of the map
  - the actual river end point is the midpoint of the coast edge between the last land cell and that sea cell
- No-sea fallback:
  - target the west-boundary edge midpoint closest to the geometric middle of the west side
  - the outlet cell must be land, not hill, and not hillside

Path traversal rules:
- Rivers move only through land cells.
- Rivers cannot traverse hills or hillsides.
- River routing uses a user-controlled minimum turn angle parameter.
- The allowed range is `0` to `120` degrees.
- The default minimum turn angle is `90` degrees.
- Path geometry is segmented:
  - source boundary midpoint
  - source cell centroid
  - shared edge midpoint
  - next cell centroid
  - ...
  - outlet midpoint
- Rivers must avoid turns sharper than the configured minimum turn angle.
- At any cell where a path turns from one edge midpoint to another edge midpoint through the cell centroid, the angle must be at least the configured minimum.
- The same minimum-angle rule also applies to the first turn leaving the boundary source cell.
- Shortest path means shortest in cell-step count first.
- If several candidate paths have the same cell-step count, the longest segmented geometric path wins.
- When the map contains sea:
  - a river cannot pass through a land cell neighboring the sea unless that cell is the target cell
  - every step must strictly reduce geometric distance to the nearest coastline midpoint
  - coastline distance is measured to edge midpoints where one adjacent cell is sea and the other is land

Selection among boundary sources:
- Every eligible one-side boundary source cell is evaluated.
- The chosen river is the longest valid result among those sources.
- Ranking is:
  - more cells in path
  - then longer segmented geometric length
  - then lower cell id

Naming rules:
- The first river name is chosen from:
  - `Valdombra`
  - `Fiume Serrano`
  - `Torrente Belloro`
  - `Rio Castellano`
  - `Fiumara Lucente`
  - `Torrente Virelli`
  - `Rio Montesco`
  - `Fiume Caldoro`
  - `Torrente Azzurri`
  - `Rio Ventoro`

State effects:
- Adds one river object to `map.rivers` when successful.
- Marks cells on that river with `features.river`.

## 7. Trace The First Tributary

Source:
- `src/generator/step-first-tributary.js`
- `src/generator/river-path.js`

Preconditions:
- A primary river from step 6 must exist.

Merge target rules:
- Tributaries may merge only into the primary river.
- Merge must happen well upstream from the outlet.
- When sea exists:
  - merge cell must be at least the configured tributary merge distance in graph steps from the sea
- When no sea exists:
  - merge cell must be at least the configured tributary merge distance away from the river outlet along the primary river ordering
- Tributary routing targets a land neighbor of the chosen merge cell.
- The tributary geometry then extends to the centroid of the actual merge cell.

Default values:
- tributary source distance from main river: `6`
- allowed tributary source distance range: `0` to `20`
- tributary merge distance: `5`
- allowed tributary merge distance range: `0` to `20`
- tributary width ratio: `0.72`
- allowed tributary width ratio range: `0.3` to `1`
- primary merge width gain: `1.2`
- allowed primary merge width gain range: `0` to `4`

Source-cell rules:
- Tributary source cell must:
  - be `land`
  - not be `hill`
  - not be `hillside`
  - not already belong to a river
  - be at least the configured tributary source distance away from the main river in graph cells
  - touch exactly one map side

Traversal rules:
- Tributaries use the same segmented land-path search as the first river.
- Tributaries cannot traverse:
  - sea
  - hill
  - hillside
  - any existing river cell
- Tributaries must obey the same configured minimum turn-angle rule as the first river.
- The merge angle between tributary entry and the downstream direction of the primary river must also satisfy the configured minimum turn angle.
- When sea exists, the same monotonic sea-seeking constraints apply during pathfinding because the shared river-path helper is used.

Selection rules:
- All eligible one-side boundary sources are evaluated.
- The chosen tributary is the longest valid result.
- Ranking is:
  - more cells in path
  - then longer segmented geometric length
  - then lower cell id

Naming rules:
- Tributary names come from the same fixed river-name list.
- Already used river names are skipped when possible.

State effects:
- Appends one river object to `map.rivers` when successful.
- Marks tributary cells with `features.river`.
- Stores tributary stroke width separately from the primary river width.
- Widens the primary river slightly downstream from the merge cell.
- Hill and hillside flags still exist at the end of this step so replay can show the temporary routing terrain.

## 8. Convert To Lot Geometry

Source: `src/generator/step-convert-lots.js`

Business rules:
- The conversion runs once after the tributary is committed.
- Every Voronoi cell becomes a lot with the same id, site, centroid, polygon, boundary flags, and feature flags.
- `hill` and `hillside` feature flags are cleared immediately before conversion because hills are temporary river-routing constraints only.
- Lot adjacency is preserved from the original shared-edge graph.
- Each original edge is resampled into straight or polyline segments targeting about 10 map units each.
- Segment count is `round(edgeLength / 10)` with a minimum of `1`.
- Segment endpoints stay fixed at the original edge endpoints.
- Boundary edges remain marked as boundary segments with only one adjacent lot.
- Interior segments keep both adjacent lot ids.
- Sea, river, and boundary classification is copied onto the new segment records.
- The old `cells` and `edges` arrays are no longer the canonical geometry after conversion.

State effects:
- Replaces `cells` and `edges` with `lots` and `segments`.
- Preserves rivers, water, and city-center metadata.

## 9. Add Rivers To Lot Geometry

Source: `src/generator/step-add-rivers-to-lot-geometry.js`

Business rules:
- River polylines are resampled into a segment model using the same approximately `10`-unit target used for lot edges.
- Where a river crosses a lot boundary, that crossing point becomes a shared topology point.
- A lot crossed by one river is split into two lots, one on each side of the river.
- A lot containing the primary/tributary merge is split into three lots that share the merge point.
- The merge point is shared by the upstream primary branch, downstream primary branch, and tributary branch.

State effects:
- Rewrites `lots` and `segments` so rivers are part of canonical lot topology.
- Preserves `map.rivers` as the source river metadata.

## 10. Tessellate Lot Geometry

Source: `src/generator/step-tessellate-lots.js`

Business rules:
- Every final lot polygon is decomposed into clipped Voronoi sublots.
- For each lot, the total sublot seed budget is `max(x + 4, ((x/2)^2)/3)` for land lots and `max(x, (x/6)^2)` for sea lots, where `x` is the number of canonical border segments.
- The same number of fixed boundary seed points is sampled evenly around the lot border.
- Voronoi cells are computed in the lot bounds, then clipped strictly to the lot polygon.
- `sublotLloydPasses` controls how many Lloyd relaxation passes are applied to interior seed points, with a default of `2`.
- `sublotBorderDistance` controls the minimum distance of interior seed points from the lot border during both throwing and Lloyd relaxation, with a default of `7`.
- Boundary seed points remain fixed during relaxation so the lot edge stays constrained.
- Sublot vertices are stored in a shared vertex list so future altitude can be computed per vertex.
- The tessellation mesh is rendered as a subtle overlay and does not intercept lot or river hover events.

State effects:
- Adds `map.tessellation.vertices`.
- Adds `map.tessellation.sublots` with polygon vertex ids, source site, site type, centroid, area, and inherited lot features.
- Adds `sublotIds` to each lot.

## Rendering And Replay Constraints Tied To Steps

- Generation runs in a background web worker so the UI remains responsive during map creation and seed search.
- Single-map generation streams progress back to the UI after every top-level step.
- During single-map generation, the visible map updates to the newest completed step frame as soon as that step finishes.
- Generation returns a replay frame for every top-level step.
- The UI initially shows the final frame after generation.
- Replay is manual only.
- `Best of 50` also runs in the background worker.
- `Best of 50` uses the currently displayed map as its baseline candidate.
- During `Best of 50`, the UI shows a small progress counter for completed samples.
- During `Best of 50`, the visible map updates only when a newly sampled seed produces a strictly better tributary than the current baseline and all previous sampled seeds.
- If no better sampled map is found, the currently displayed map remains unchanged.
- Step 5 has a hover-only river preview overlay that uses the same center-sea path helper as step 6.
- Step 10 becomes the displayed canonical map model for replay, hover, and rendering.
- Step timing in milliseconds is shown beside each step in the UI and is approximate.

## Maintenance Rule

Any change to:
- path constraints
- hill rules
- sea rules
- source eligibility
- target selection
- tie-break logic
- replay-visible generation behavior

must update this file in the same commit.
