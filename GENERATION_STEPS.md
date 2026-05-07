# Generation Steps

This file is the implemented geometry contract for the deterministic generation pipeline. Keep it aligned with `src/generator/steps.js`, `src/generator/city-generator.js`, and the numbered step folders under `src/generator/`.

Each step is a simple function. Its input is exactly the previous step output, except step 1.1, which takes the seeded RNG and initial parameters. Each step owns one numbered folder and one numbered step file. If a step has multiple algorithms, keep the step entry file separate from one file per algorithm. Rename folders and files whenever the step ordering changes so the numeric prefix always matches the canonical step number.

## Canonical Order

1. Geographical features
1.1 Point cloud
1.2 Voronoi cells
1.3 Relaxed cells
1.4 Collapsed edges
1.5 Sea mask
1.7 Primary river
1.8 River branch
1.9 Coastline mesh
1.10 River splits
2. Human occupation
2.1 Route graph
2.2 Parish clustering
2.3 Road network
2.4 Parish borders
2.5 Land edges segmentation
2.6 Field dispatch

## Geometry Rules

Through step 1.8 the map is cell geometry:

```js
{
  meta: { size: 3000, stepIndex: 5, stepLabel: "Primary river" },
  points: [{ id: 0, x: 120, y: 240 }, ...],
  vertices: [{ id: 0, x: 10, y: 20, edgeIds: ["0-1-..."] }, ...],
  edges: [{
    id: "0-1-...",
    fromVertexId: 0,
    toVertexId: 1,
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    leftCellId: 0,
    rightCellId: 1,
    features: { boundary: false, sea: false, river: false }
  }, ...],
  cells: [{
    id: 0,
    site: { id: 0, x: 120, y: 240 },
    centroid: { x: 125, y: 236 },
    vertexIds: [0, 1, 2, ...],
    edgeIds: ["0-1-...", ...],
    neighborCellIds: [1, 8, ...],
    boundarySides: [],
    features: { land: true, sea: false, river: false, boundary: false, cityCenter: false }
  }, ...],
  river: { primary: null, secondary: null },
  rivers: []
}
```

From step 1.9 onward the map is lot geometry. Previous `cells`, `edges`, and cell `vertices` are not part of the output:

```js
{
  lots: [{
    id: 0,
    centroid: { x: 125, y: 236 },
    polygon: [{ x: 10, y: 20 }, ...],
    vertexIds: [0, 1, 2, ...],
    segmentIds: ["boundary-0:0", ...],
    neighborLotIds: [1, 8, ...],
    features: { land: true, sea: false, river: false, boundary: false, cityCenter: false }
  }, ...],
  vertices: [{
    id: 0,
    x: 10,
    y: 20,
    segmentIds: ["boundary-0:0", ...],
    features: { coast: false, land: true, sea: false, riverside: false }
  }, ...],
  segments: [{
    id: "boundary-0:0",
    fromVertexId: 0,
    toVertexId: 1,
    from: { x: 10, y: 20 },
    to: { x: 18, y: 26 },
    leftLotId: 0,
    rightLotId: 1,
    features: { boundary: false, coast: false, land: true, sea: false, river: false, riverside: false }
  }, ...],
  river: { primary: { ... }, secondary: { ... } },
  rivers: [{ ... }, { ... }]
}
```

The `rivers` array is kept for renderer compatibility. The canonical named fields are `river.primary` and `river.secondary`.

## 1.1 Scatter Pseudo-Random Points

Source: `src/generator/1-1-scatter-points/1-1-scatter-points.js`

Function input:

```js
{
  rng,
  map: {
    meta: { size: 3000 },
    init: { params: { pointCount: 500, scatterPaddingRatio: 0.01, ... } }
  }
}
```

Function output:

```js
{
  points: [{ id: 0, x: 123.4, y: 456.7 }, ...],
  vertices: [],
  cells: [],
  edges: [],
  river: { primary: null, secondary: null },
  rivers: []
}
```

Rules:
- The seeded RNG is the only source of randomness.
- Point ids are sequential and stable from `0` to `pointCount - 1`.
- Points are sampled inside the map bounds with `scatterPaddingRatio`.

## 1.2 Compute Voronoi Cells And Edges

Source: `src/generator/1-2-build-voronoi/1-2-build-voronoi.js`

Function input:

```js
{
  points: [{ id: 0, x: 123.4, y: 456.7 }, ...],
  meta: { size: 3000 }
}
```

Function output:

```js
{
  points: [{ id: 0, x: 123.4, y: 456.7 }, ...],
  vertices: [{ id: 0, x: 100, y: 200, edgeIds: ["0-1-..."] }, ...],
  edges: [{
    id: "0-1-...",
    fromVertexId: 0,
    toVertexId: 1,
    leftCellId: 0,
    rightCellId: 1,
    features: { boundary: false, sea: false, river: false }
  }, ...],
  cells: [{
    id: 0,
    vertexIds: [0, 1, 2, ...],
    edgeIds: ["0-1-...", ...],
    neighborCellIds: [1, 7, ...],
    features: { land: true, sea: false, river: false, boundary: false, cityCenter: false }
  }, ...]
}
```

Rules:
- The Voronoi diagram is clipped to the rectangular map bounds.
- Vertices know the edge ids that use them.
- Edges know their two vertices and their two neighboring cells; one neighboring cell may be `null` on the map boundary.
- Cells know their vertices, edges, and neighboring cells.
- Adjacency is derived from shared clipped Voronoi edges.

## 1.3 Apply One Lloyd Relaxation Pass

Source: `src/generator/1-3-relax-points/1-3-relax-points.js`

Function input:

```js
{
  points: [{ id: 0, x: 123.4, y: 456.7 }, ...],
  cells: [{ id: 0, site: { id: 0, ... }, centroid: { x: 130, y: 450 }, features: { boundary: false, ... } }, ...],
  edges: [...]
}
```

Function output:

```js
{
  points: [{ id: 0, x: 130, y: 450 }, ...],
  vertices: [{ id: 0, edgeIds: [...] }, ...],
  cells: [{ id: 0, vertexIds: [...], edgeIds: [...], neighborCellIds: [...], features: { land: true, sea: false, ... } }, ...],
  edges: [{ id: "...", fromVertexId: 0, toVertexId: 1, ... }, ...],
  river: { primary: null, secondary: null },
  rivers: []
}
```

Rules:
- Exactly one Lloyd pass is applied.
- Boundary sites stay fixed.
- Non-boundary sites move to their cell centroids and are clamped by `relaxPaddingRatio`.
- Voronoi geometry is rebuilt.

## 1.4 Collapse Short Edges

Source: `src/generator/1-4-collapse-short-edges/1-4-collapse-short-edges.js`

Function input:

```js
{
  vertices: [{ id: 0, x: 100, y: 200, edgeIds: ["..."] }, ...],
  edges: [{ id: "...", fromVertexId: 0, toVertexId: 1, from: { x: 100, y: 200 }, to: { x: 104, y: 203 }, ... }, ...],
  cells: [{ id: 0, vertexIds: [0, 1, 2, ...], edgeIds: ["..."], neighborCellIds: [...] }, ...]
}
```

Function output:

```js
{
  vertices: [{ id: 0, x: 102, y: 201.5, edgeIds: ["collapsed:0", "collapsed:9", "collapsed:12"] }, ...],
  edges: [{ id: "collapsed:0", fromVertexId: 0, toVertexId: 4, leftCellId: 0, rightCellId: 1, features: { boundary: false, sea: false, river: false } }, ...],
  cells: [{ id: 0, vertexIds: [0, 4, 8, ...], edgeIds: ["collapsed:0", ...], neighborCellIds: [1, ...] }, ...],
  river: { primary: null, secondary: null },
  rivers: []
}
```

Rules:
- Sort candidate cell edges by geometric length.
- Take the shortest candidate edge.
- If its length is lower than `collapseShortEdgeLength`, delete that edge by merging its two vertices.
- Interior vertices merge at their midpoint.
- If either merged vertex is on the square map boundary, the merged vertex must also be on the same boundary side.
- If the merged vertices include a corner constraint, the merged vertex stays on that corner so the map remains a perfect square.
- Repeat until no remaining edge is lower than `collapseShortEdgeLength`.
- `collapseShortEdgeLength` defaults to 35 and is clamped to the 0-100 range.
- Rebuild cell polygons, edges, edge ownership, vertex edge lists, and cell neighbors from the simplified vertex rings.
- Merged vertices may legally be part of three or more edges.

## 1.5 Select And Paint Sea Areas

Source: `src/generator/1-5-apply-water/1-5-apply-water.js`

Function input:

```js
{
  vertices: [{ id: 0, edgeIds: [...] }, ...],
  edges: [{ id: "collapsed:0", leftCellId: 0, rightCellId: 1, features: { sea: false, ... } }, ...],
  cells: [{ id: 0, neighborCellIds: [1, ...], features: { land: true, sea: false, ... } }, ...],
  init: { params: { waterSides: [{ name: "west", enabled: true }, ...], waterReachRatio: 0.2, ... } }
}
```

Function output:

```js
{
  cells: [{ id: 0, features: { land: false, sea: true, ... } }, ...],
  edges: [{ id: "collapsed:0", features: { sea: true, ... } }, ...],
  water: { sides: ["west"], seaCellIds: [0, 4, ...] }
}
```

Rules:
- Enabled outer sides seed water.
- Water expands through cell neighbors using the seeded RNG.
- Cell `features.land` is the inverse of `features.sea`.
- Edge `features.sea` is true only when both neighboring cells are sea.

## 1.7 Trace The First River

Source: `src/generator/1-7-first-river/1-7-first-river.js`

Function input:

```js
{
  cells: [{ id: 0, centroid: { ... }, neighborCellIds: [...], features: { land: true, sea: false } }, ...],
  edges: [{ id: "...", midpoint: { ... }, leftCellId: 0, rightCellId: 1 }, ...],
  primaryRiverTurnAngleDegrees: 30,
  river: { primary: null, secondary: null },
  rivers: []
}
```

Function output:

```js
{
  cells: [{ id: 12, features: { river: true, ... } }, ...],
  river: {
    primary: {
      id: 0,
      name: "Valdombra",
      sourceCellId: 12,
      targetSeaCellId: 44,
      cellIds: [12, 18, 27, ...],
      points: [{ x: 0, y: 220 }, { x: 32, y: 230 }, { x: 48, y: 242 }, ...],
      length: 340.5,
      strokeWidth: 6
    },
    secondary: null
  },
  rivers: [{ id: 0, ... }]
}
```

Rules:
- `seaDistance` is computed as the minimum neighbor-to-neighbor distance from each cell to any sea cell.
- Primary routing starts from a river mouth candidate on the coast and searches inland.
- The river must end on a land cell touching the map boundary.
- The river cannot loop or revisit a cell already in its current path.
- The next candidate cell cannot be adjacent to the previous cell in the current path.
- The river cannot turn sharper than the configured turn angle at any centroid turn or edge-midpoint turn in the stored river polyline.
- Candidate paths are ranked by geometric polyline length, then cell count, then stable ids.

Plain-language algorithm:
- Select sea cells that touch more than one land cell and sit on the central 50% of an enabled water boundary side. North/south use the cell centroid `x`; east/west use centroid `y`.
- Select mouth land cells that touch one selected sea cell and exactly one sea cell total.
- For each mouth land cell, enumerate bounded inland paths across land neighbors.
- If the current river head has `seaDistance <= 3`, the next cell must have strictly greater `seaDistance`.
- If the current river head has `seaDistance > 3`, the route may move closer to sea once before the next strict increase, or keep the same sea distance twice before the next strict increase.
- Stop a candidate path when it reaches a land map-boundary cell.
- Build the stored river in source-to-mouth order: boundary source point, cell centroids, shared edge midpoints, mouth cell centroid, then the coast edge midpoint.
- Save the selected path as `river.primary` and `rivers[0]`, mark its cells with `features.river`, assign a seeded name, and give it `primaryRiverWidth`.

## 1.8 Trace The First Tributary

Source: `src/generator/1-8-first-tributary/1-8-first-tributary.js`

Function input:

```js
{
  cells: [{ id: 0, features: { land: true, river: false, sea: false }, ... }, ...],
  edges: [{ id: "...", midpoint: { ... }, leftCellId: 0, rightCellId: 1 }, ...],
  tributaryRiverTurnAngleDegrees: 30,
  river: { primary: { id: 0, cellIds: [12, 18, 27, ...], ... }, secondary: null },
  rivers: [{ id: 0, ... }]
}
```

Function output:

```js
{
  cells: [{ id: 31, features: { river: true, ... } }, ...],
  river: {
    primary: { id: 0, widthMergeCellId: 27, strokeWidthBeforeMerge: 18, strokeWidthAfterMerge: 21.6, ... },
    secondary: {
      id: 1,
      mergedIntoRiverId: 0,
      mergeCellId: 27,
      cellIds: [31, 30, 24, ...],
      points: [{ x: 3000, y: 360 }, { x: 2910, y: 390 }, ...]
    }
  },
  rivers: [{ id: 0, ... }, { id: 1, ... }]
}
```

Rules:
- Tributary routing starts from valid primary river merge cells and searches inland.
- A primary river cell is merge-eligible when its `seaDistance` is at least 5.
- It cannot loop or revisit a cell already in its current path.
- It cannot enter existing primary river cells after leaving the merge cell.
- After leaving the merge and first tributary cell, it cannot enter any cell neighboring a primary river cell.
- The next candidate cell cannot be adjacent to the previous cell in the current path.
- It cannot turn sharper than the configured turn angle at any centroid turn or edge-midpoint turn, using the same angle rule as the primary river.
- It must end on a land cell touching the map boundary.
- The primary river width is increased downstream of the merge cell.

Plain-language algorithm:
- If there is no primary river, no tributary is created.
- Inspect the primary river and use every primary cell with `seaDistance >= 5` as a possible merge start.
- From each merge cell, enumerate bounded inland paths with the same sea-distance movement rules as the primary river.
- Stop a candidate path when it reaches a land map-boundary cell.
- Score each tributary as tributary polyline length plus Euclidean distance between the tributary boundary source point and the primary boundary source point.
- Choose the highest score, then tie-break by tributary length, endpoint distance, merge cell id, and source cell id.
- Save the selected branch as `river.secondary` and `rivers[1]`, set `mergedIntoRiverId` and `mergeCellId`, mark its cells as river cells, and give it `primaryRiverWidth * tributaryWidthRatio`.
- Update the primary river width metadata so rendering can draw it narrower before the merge and wider downstream: `strokeWidthBeforeMerge` stays at the base width, `strokeWidthAfterMerge` adds `primaryMergeWidthGain`, and `widthMergeCellId` records where that change starts.

Primary vs tributary:
- The primary starts from a selected sea mouth and searches inland to a boundary source. The tributary starts from a primary merge cell and searches inland to its own boundary source.
- Both use the same sea-distance movement rules.
- The primary chooses the longest geometric path. The tributary chooses the highest branch-length plus endpoint-separation score.
- The primary owns the base river width. The tributary is narrower, and its merge increases the primary width only downstream of the merge cell.

## 1.9 Build Coastline Geometry

Source: `src/generator/1-9-build-coastline-geometry/1-9-build-coastline-geometry.js`

Function input:

```js
{
  cells: [{ id: 0, polygon: [{ x: 10, y: 20 }, ...], edgeIds: [...], features: { land: true, sea: false, ... } }, ...],
  edges: [{ id: "...", fromVertexId: 0, toVertexId: 1, leftCellId: 0, rightCellId: 1, features: { sea: false } }, ...],
  river: { primary: { ... }, secondary: { ... } }
}
```

Function output:

```js
{
  lots: [{ id: 0, polygon: [{ x: 10, y: 20 }, ...], vertexIds: [0, 1, ...], segmentIds: ["..."], features: { land: true, sea: false, river: true } }, ...],
  vertices: [{ id: 0, x: 10, y: 20, segmentIds: ["..."], features: { coast: false, land: true, sea: false, riverside: false } }, ...],
  segments: [{ id: "...", fromVertexId: 0, toVertexId: 1, leftLotId: 0, rightLotId: 1, features: { coast: false, land: true, sea: false, river: false, riverside: false } }, ...],
  river: { primary: { ... }, secondary: { ... } },
  rivers: [{ ... }, { ... }]
}
```

Rules:
- Cells become lots and coastline chains are traced from land/sea edges.
- Coastline corners become quadratic Bezier curves from the previous coast-edge midpoint to the next coast-edge midpoint, controlled by the shared Voronoi vertex.
- Boundary-ending coastline chains synthesize the missing exterior midpoint by mirroring the adjacent midpoint across the endpoint.
- Bezier curves are sampled at the default segment length and emitted only as ordinary vertices and segments.
- Non-coast edges that touched an original coast vertex reconnect to the sampled curve point nearest that original vertex.
- Lots inherit source cell features.
- Segment and vertex features are limited to lot-stage surface data such as `coast`, `land`, `sea`, and later `riverside`.
- Cell geometry is removed from the output; later work uses lots only.

## 1.10 Add Rivers To Lot Geometry

Source: `src/generator/1-10-add-rivers-to-lot-geometry/1-10-add-rivers-to-lot-geometry.js`

Rules:
- River path bends are smoothed with the same midpoint-control-point Bezier-style construction used for coastline corners.
- River source, outlet, and tributary merge vertices are pinned exactly so tributaries and primary rivers share the same merge vertex.
- Smoothed river paths are sampled into segment geometry.
- Lots crossed by rivers are split.
- River-derived segments and their vertices receive `features.riverside`.
- River segments are canonical `segments`; they are not stored again in a river-specific output field.
- Lot adjacency and segment ownership are rebuilt from the new polygons.

## 2.1 Route Graph

Source: `src/generator/2-1-build-route-graph/2-1-build-route-graph.js`

Function input:

```js
{
  lots: [{ id: 0, centroid: { x: 100, y: 100 }, features: { land: true, sea: false }, ... }, ...],
  vertices: [{ id: 0, x: 10, y: 20, segmentIds: ["segment:0"], features: { ... } }, ...],
  segments: [{ id: "segment:0", from: { x: 10, y: 20 }, to: { x: 30, y: 20 }, leftLotId: 0, rightLotId: 1, features: { river: false }, ... }, ...]
}
```

Function output:

```js
{
  routeGraph: {
    nodes: [{ id: 0, x: 10, y: 20, routeIds: ["route:0"], type: "road", sourceVertexIds: [4] }, ...],
    routes: [{ id: "route:0", fromNodeId: 0, toNodeId: 1, type: "road", sourceSegmentId: "segment:0", leftLotId: 0, rightLotId: 1, ... }, ...]
  }
}
```

Rules:
- Segment endpoints are deduplicated into graph nodes.
- Existing canonical segments are preserved and each valid segment becomes one route.
- Route types are `road`, `coast`, `river`, `sea`, and later `alley`.
- `road` routes are land-to-land non-river segments.
- `coast` routes are land/sea boundaries.
- `river` routes are river segments between land geometry.
- `sea` routes are pure sea segments.
- Node types are derived from linked routes.
- `river_mouth` nodes are linked to a river route and a sea or coast route.
- `river_crossing` nodes are linked to river and road routes.
- Legacy `vertices` and `segments` remain in the map for renderer compatibility.

## 2.2 Parish Clustering

Source: `src/generator/2-2-group-lots/2-2-group-lots.js`

Function input:

```js
{
  lots: [{ id: 0, centroid: { x: 100, y: 100 }, features: { land: true, sea: false }, ... }, ...],
  routeGraph: { nodes: [{ id: 0, type: "road", ... }], routes: [{ id: "route:0", type: "road", ... }, ...] },
  init: { params: { parishCount: 15, routeCrossingCost: 1500, stepAlgorithms: { parishClustering: "graph_kmeans" } } }
}
```

Function output:

```js
{
  lots: [{ id: 0, parishId: 3, parishLetter: "D", parishName: "Santa Elena", parish: "Santa Elena", ... }, ...],
  parishColors: ["hsla(0, 60%, 70%, 0.4)", ...],
  parishCenters: [{ parishId: 0, letter: "A", lotId: 12, nodeId: 88, x: 100, y: 200, centroid: { x: 95, y: 205 } }, ...],
  routeGraph: { nodes: [{ type: "lot_center", lotId: 12, ... }], routes: [{ type: "alley", features: { lotCenterAlley: true }, ... }, ...] }
}
```

Rules:
- Land lots are grouped into exactly `parishCount` clusters (if enough lots exist).
- Step 2.2 adds one `lot_center` route node per land lot and `alley` routes from that center only to existing lot-corner graph nodes that already link at least three road routes.
- Coast, river, sea, and river-crossing nodes are not connected by center alleys.
- Parish distance is computed between lot center nodes over the route graph.
- Road route length is weighted by 3, center-junction alley route length is weighted by 6, and river crossing nodes add `routeCrossingCost` only when reached by road routes.
- `graph_kmeans` assigns lots to nearest parish center node by weighted graph distance, recomputes each center from the average lot centroid, then snaps that point to the nearest land lot center node.
- `route_growth` picks graph-spread center-node seeds and grows parishes by weighted route distance.
- `graph_kmedoids` assigns lots by weighted graph distance and chooses each parish center as the assigned lot center minimizing in-cluster graph distance.
- Parish centers identify the selected center lot and center node for display.
- Parishes are lettered `A` through `Z` and named from a static list of 50 `Santo ...` / `Santa ...` names; each assigned lot stores `parishId`, `parishLetter`, `parishName`, and `parish`.
- Parishes are colored greedily to avoid adjacent parishes sharing the same color index from the generated HSL palette.
- Step 2.2 only accepts lot center nodes as route START points.
- From step 2.2 onward, route endpoint dots are hidden, route lines are wider, alley routes are medium gray, and parish centers remain visible.

## 2.3 Road Network

Source: `src/generator/2-3-build-road-network/2-3-build-road-network.js`

Rules:
- Existing physical land `road` routes are demoted to `alley`; river, sea, and coast routes keep their route types.
- The selectable algorithms are `boundary_connectors` and `parish_center_spine`; `boundary_connectors` is the default.
- Temporary parish-center alleys are added only for the selected parish-center lots, using the same eligible junction rule as step 2.2.
- In `boundary_connectors`, routes that follow a parish boundary have doubled pathfinding cost.
- In `boundary_connectors`, parish-boundary lots receive a temporary centroid node with virtual alleys from each boundary route node to the centroid and from the centroid to same-lot route nodes that are not on the parish boundary.
- The parish center closest to the map midpoint becomes the center parish.
- Each iteration finds the cheapest weighted path from the center parish to any unlinked parish center over roads and alleys.
- The nearest unlinked parish path is promoted to road, and subsequent iterations include those cheaper road weights.
- River crossing nodes on promoted paths become bridges and add no further crossing penalty.
- Each newly added bridge multiplies the future river crossing penalty by 1.5.
- Temporary parish-center alleys used by a selected path become persistent `street` routes and are treated like roads.
- Temporary boundary-lot virtual alleys used by a selected path become persistent `road` routes.
- Unused temporary parish-center alleys are removed from the final route graph.
- Unused temporary boundary-lot virtual alleys are removed from the final route graph.
- Final physical routes keep either `road` or `alley` type/features for later geometry rebuilds.

## 2.4 Build Parish Borders

Source: `src/generator/2-4-build-parish-borders/2-4-build-parish-borders.js`

Rules:
- Coastline and sea segments are preserved.
- Segments between two different parishes are marked with `features.parishBoundary`.
- Displayed parish outlines include inter-parish borders plus coast, sea, and map-boundary edges adjacent to the parish.
- Only same-parish-pair border chains are smoothed, using the same midpoint-control quadratic sampling strategy used for rivers and coasts.
- Nodes touching coast, river, sea, or map-boundary segments stay fixed.
- Protected parish-border vertices break smoothing chains; single-segment borders stay straight.
- Smoothed parish-border spans are marked with `features.parishBoundarySmoothed`.
- Lot polygons, vertex ids, segment ids, adjacency, and route graph are rebuilt from the parish-border-smoothed geometry.

## 2.5 Build Land-Edge Segmentation

Source: `src/generator/2-5-build-land-edge-geometry/2-5-build-land-edge-geometry.js`

Rules:
- Coastline, sea segments, and already-smoothed parish-border paths are preserved.
- Remaining non-sea land and boundary edges are resampled as straight segments at double the coastline segment length.
- Lot polygons, vertex ids, segment ids, and adjacency are rebuilt from the normalized geometry.
- `routeGraph` is rebuilt from the updated canonical segments, preserving `parishBoundary` and `parishBoundarySmoothed` on routes for later steps.

## 2.6 Field Dispatch

Source: `src/generator/2-6-field-dispatch/2-6-field-dispatch.js`

Function input:

```js
{
  lots: [{ id: 0, polygon: [{ x: 10, y: 20 }, ...], features: { land: true, sea: false } }, ...],
  vertices: [{ id: 0, x: 10, y: 20, ... }, ...],
  segments: [{ id: "segment:0", ... }, ...]
}
```

Function output:

```js
{
  lots: [{
    id: 0,
    sublotIds: [0, 1],
    sublots: [{ id: 0, lotId: 0, vertexIds: [0, 1, 2], neighborSublotIds: [1], neighborLotIds: [4], features: { land: true, sea: false } }, ...],
    ...
  }, ...],
  tessellation: {
    vertices: [{ id: 0, x: 10, y: 20 }, ...],
    sublots: [{ id: 0, lotId: 0, vertexIds: [0, 1, 2], centroid: { x: 20, y: 30 }, area: 100, neighborSublotIds: [1], neighborLotIds: [4], features: { land: true, sea: false } }, ...]
  },
  routeGraph: { nodes: [...], routes: [{ type: "alley", leftSublotId: 0, rightSublotId: 1, ... }, ...] }
}
```

Rules:
- The step output shape is identical regardless of the selected tessellation algorithm.
- Only the 15 land lots with the highest area that are not touching the map boundaries are selected for tessellation.
- `straight_bisection` starts recursive sublotting for each selected land lot when a valid split exists.
- In `straight_bisection`, each branch tries the shortest valid straight bisection and the smaller child must keep at least 40% of the parent branch area.
- In `curved_bisection`, the same recursive split selection is used, but the inserted split edge is a cubic Hermite curve instead of a straight chord.
- In `curved_bisection`, each curve starts at the chosen boundary vertices and uses endpoint tangent directions derived from the inward half-angle bisectors of those vertices.
- Lots that do not produce at least two valid pieces do not create one-piece sublots.
- Canonical lot-boundary vertices include segment endpoints on the lot boundary, not only the coarse `lot.polygon` corners.
- Parent and intermediate sublots are removed; only final leaf sublots are emitted.
- Sublots can be neighbours with other sublots and with neighboring lots.
- Sublot neighbours are stored separately as `neighborSublotIds` and `neighborLotIds`.
- Sublots reuse lot-boundary geometry; they do not go back to Voronoi cells.
- Split lots receive `sublotIds` and an inline `sublots` list; unsplit lots keep both lists empty.
- Shared edges between final leaf sublots are appended to `routeGraph.routes` as `alley` routes.
- Alley route endpoints reuse existing graph nodes when their coordinates match, otherwise they create new nodes.
