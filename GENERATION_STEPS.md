# Generation Steps

This file is the implemented geometry contract for the deterministic generation pipeline. Keep it aligned with `src/generator/steps.js`, `src/generator/city-generator.js`, and the step files under `src/generator/`.

Each step is a simple function. Its input is exactly the previous step output, except step 1.1, which takes the seeded RNG and initial parameters. Each step owns one file, and any helper used by more than one step belongs in a helper module such as `cell-graph.js`, `geometry.js`, `map-model.js`, `river-model.js`, or `river-path.js`.

## Canonical Order

1. Geographical feature
1.1 Scatter pseudo-random points
1.2 Compute Voronoi cells and edges
1.3 Select and paint sea areas
1.4 Apply one Lloyd relaxation pass
1.5 Collapse short edges
1.6 Flag inland hill cells
1.7 Trace the first river
1.8 Trace the first tributary
1.9 Convert to lot geometry
1.10 Add rivers to lot geometry
1.11 Tessellate lot geometry
2. Human usage

`Human usage` is reserved and has no implemented child steps yet.

## Geometry Rules

Through step 1.8 the map is cell geometry:

```js
{
  meta: { size: 1000, stepIndex: 6, stepLabel: "Trace the first river" },
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
    features: { land: true, sea: false, hill: false, hillside: false, river: false, boundary: false, cityCenter: false }
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

Source: `src/generator/step-scatter-points.js`

Function input:

```js
{
  rng,
  map: {
    meta: { size: 1000 },
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

Source: `src/generator/step-build-voronoi.js`

Function input:

```js
{
  points: [{ id: 0, x: 123.4, y: 456.7 }, ...],
  meta: { size: 1000 }
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
    features: { land: true, sea: false, hill: false, hillside: false, river: false, boundary: false, cityCenter: false }
  }, ...]
}
```

Rules:
- The Voronoi diagram is clipped to the rectangular map bounds.
- Vertices know the edge ids that use them.
- Edges know their two vertices and their two neighboring cells; one neighboring cell may be `null` on the map boundary.
- Cells know their vertices, edges, and neighboring cells.
- Adjacency is derived from shared clipped Voronoi edges.

## 1.3 Select And Paint Sea Areas

Source: `src/generator/step-apply-water.js`

Function input:

```js
{
  vertices: [{ id: 0, edgeIds: [...] }, ...],
  edges: [{ id: "0-1-...", leftCellId: 0, rightCellId: 1, features: { sea: false, ... } }, ...],
  cells: [{ id: 0, neighborCellIds: [1, ...], features: { land: true, sea: false, ... } }, ...],
  init: { params: { waterSides: [{ name: "west", enabled: true }, ...], waterReachRatio: 0.2, ... } }
}
```

Function output:

```js
{
  cells: [{ id: 0, features: { land: false, sea: true, ... } }, ...],
  edges: [{ id: "0-1-...", features: { sea: true, ... } }, ...],
  water: { sides: ["west"], seaCellIds: [0, 4, ...] }
}
```

Rules:
- Enabled outer sides seed water.
- Water expands through cell neighbors using the seeded RNG.
- Cell `features.land` is the inverse of `features.sea`.
- Edge `features.sea` is true only when both neighboring cells are sea.

## 1.4 Apply One Lloyd Relaxation Pass

Source: `src/generator/step-relax-points.js`

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
- Voronoi geometry is rebuilt and sea classification is recomputed.

## 1.5 Collapse Short Edges

Source: `src/generator/step-collapse-short-edges.js`

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
- If its length is lower than `DEFAULT_SEGMENT_LENGTH`, delete that edge by merging its two vertices at their midpoint.
- Repeat until no remaining edge is lower than `DEFAULT_SEGMENT_LENGTH`.
- Rebuild cell polygons, edges, edge ownership, vertex edge lists, and cell neighbors from the simplified vertex rings.
- Merged vertices may legally be part of three or more edges.

## 1.6 Flag Inland Hill Cells

Source: `src/generator/step-flag-hills.js`

Function input:

```js
{
  cells: [{ id: 0, neighborCellIds: [1, ...], features: { land: true, sea: false, hill: false, hillside: false } }, ...],
  init: { params: { hillCount: 9, hillSeaDistance: 4, hillsideRadius: 1 } }
}
```

Function output:

```js
{
  cells: [{ id: 0, features: { land: true, sea: false, hill: true, hillside: false, ... } }, ...]
}
```

Rules:
- Hill placement uses graph distance through cells.
- A hill candidate must be land and at least `hillSeaDistance` steps from sea.
- The first hill is random; later hills maximize distance from selected hills.
- Hillside cells are land cells within `hillsideRadius` steps of a hill.

## 1.7 Trace The First River

Source: `src/generator/step-first-river.js`

Function input:

```js
{
  cells: [{ id: 0, centroid: { ... }, neighborCellIds: [...], features: { land: true, hill: false, hillside: false } }, ...],
  edges: [{ id: "...", midpoint: { ... }, leftCellId: 0, rightCellId: 1 }, ...],
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
- The source is a one-side boundary land cell.
- Hills and hillsides cannot be traversed.
- The path alternates boundary vertex or edge midpoint, cell centroid, shared edge midpoint, next cell centroid, and outlet point.
- Candidate paths are ranked by cell count, then segmented geometric length, then source cell id.

## 1.8 Trace The First Tributary

Source: `src/generator/step-first-tributary.js`

Function input:

```js
{
  cells: [{ id: 0, features: { land: true, river: false, hill: false, hillside: false }, ... }, ...],
  edges: [{ id: "...", midpoint: { ... }, leftCellId: 0, rightCellId: 1 }, ...],
  river: { primary: { id: 0, cellIds: [12, 18, 27, ...], ... }, secondary: null },
  rivers: [{ id: 0, ... }]
}
```

Function output:

```js
{
  cells: [{ id: 31, features: { river: true, ... } }, ...],
  river: {
    primary: { id: 0, widthMergeCellId: 27, strokeWidthBeforeMerge: 6, strokeWidthAfterMerge: 7.2, ... },
    secondary: {
      id: 1,
      mergedIntoRiverId: 0,
      mergeCellId: 27,
      cellIds: [31, 30, 24, ...],
      points: [{ x: 1000, y: 120 }, { x: 970, y: 130 }, ...]
    }
  },
  rivers: [{ id: 0, ... }, { id: 1, ... }]
}
```

Rules:
- The tributary source is a one-side boundary land cell.
- It cannot cross hills, hillsides, or existing river cells.
- It must merge into a valid primary river cell.
- The primary river width is increased downstream of the merge cell.

## 1.9 Convert To Lot Geometry

Source: `src/generator/step-convert-lots.js`

Function input:

```js
{
  cells: [{ id: 0, polygon: [{ x: 10, y: 20 }, ...], edgeIds: [...], features: { land: true, hill: false, hillside: false, ... } }, ...],
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
- Cells become lots.
- Edges become sampled segments.
- Lots inherit source cell features, except temporary hill and hillside features are cleared before this step.
- Segment and vertex features are limited to lot-stage surface data such as `coast`, `land`, `sea`, and later `riverside`.
- Cell geometry is removed from the output; later work uses lots only.

## 1.10 Add Rivers To Lot Geometry

Source: `src/generator/step-add-rivers-to-lot-geometry.js`

Function input:

```js
{
  lots: [{ id: 0, polygon: [...], segmentIds: [...], features: { land: true, river: true } }, ...],
  vertices: [{ id: 0, features: { riverside: false, ... } }, ...],
  segments: [{ id: "...", features: { riverside: false, river: false, ... } }, ...],
  river: { primary: { points: [...] }, secondary: { points: [...] } },
  rivers: [{ points: [...] }, ...]
}
```

Function output:

```js
{
  lots: [{ id: 0, polygon: [{ x: 10, y: 20 }, ...], vertexIds: [...], segmentIds: [...], neighborLotIds: [...] }, ...],
  vertices: [{ id: 22, x: 150, y: 300, segmentIds: ["segment:88"], features: { riverside: true, coast: false, land: true, sea: false } }, ...],
  segments: [{ id: "segment:88", fromVertexId: 22, toVertexId: 23, features: { river: true, riverside: true, land: true, coast: false, sea: false } }, ...]
}
```

Rules:
- River paths are sampled into segment geometry.
- Lots crossed by rivers are split.
- River-derived segments and their vertices receive `features.riverside`.
- River segments are canonical `segments`; they are not stored again in a river-specific output field.
- Lot adjacency and segment ownership are rebuilt from the new polygons.

## 1.11 Tessellate Lot Geometry

Source: `src/generator/step-tessellate-lots.js`

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
    sublots: [{ id: 0, lotId: 0, vertexIds: [0, 1, 2], features: { land: true, sea: false } }, ...],
    ...
  }, ...],
  tessellation: {
    vertices: [{ id: 0, x: 10, y: 20 }, ...],
    sublots: [{ id: 0, lotId: 0, vertexIds: [0, 1, 2], centroid: { x: 20, y: 30 }, area: 100, features: { land: true, sea: false } }, ...]
  }
}
```

Rules:
- The largest land lots are split into two simple sublots.
- Sublots reuse lot-boundary geometry; they do not go back to Voronoi cells.
- Each lot receives `sublotIds` and an inline `sublots` list.
