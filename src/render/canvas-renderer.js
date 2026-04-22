const COLORS = {
  background: "#f5f2ea",
  grid: "rgba(24, 33, 38, 0.06)",
  landFill: "#f1eadb",
  centerFill: "#efc8c3",
  point: "#d6693c",
  edge: "#1a2026",
  seaFill: "#7ebbd4",
  seaEdge: "#1f4e72",
};

export function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  clearBase(ctx, canvas.width);
}

export function drawCityMap(canvas, map) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  clearBase(ctx, size);
  drawCells(ctx, map.cells);
  drawEdges(ctx, map.edges);
  if (!map.cells.length) {
    drawPoints(ctx, map.points);
  }
}

export function drawReplayFrame(canvas, frame) {
  if (!frame || frame.type === "blank") {
    clearCanvas(canvas);
    return;
  }

  drawCityMap(canvas, frame.map);
}

function clearBase(ctx, size) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let offset = 0; offset <= size; offset += size / 12) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset, size);
    ctx.moveTo(0, offset);
    ctx.lineTo(size, offset);
    ctx.stroke();
  }
}

function drawCells(ctx, cells) {
  cells.forEach((cell) => {
    if (cell.polygon.length < 3) {
      return;
    }

    ctx.beginPath();
    ctx.moveTo(cell.polygon[0].x, cell.polygon[0].y);
    for (let index = 1; index < cell.polygon.length; index += 1) {
      ctx.lineTo(cell.polygon[index].x, cell.polygon[index].y);
    }
    ctx.closePath();
    ctx.fillStyle = cell.isSea ? COLORS.seaFill : cell.isCityCenter ? COLORS.centerFill : COLORS.landFill;
    ctx.fill();
  });
}

function drawEdges(ctx, edges) {
  edges.forEach((edge) => {
    ctx.beginPath();
    ctx.strokeStyle = edge.kind === "sea" ? COLORS.seaEdge : COLORS.edge;
    ctx.lineWidth = 1.2;
    ctx.moveTo(edge.from.x, edge.from.y);
    ctx.lineTo(edge.to.x, edge.to.y);
    ctx.stroke();
  });
}

function drawPoints(ctx, points) {
  points.forEach((point) => {
    ctx.beginPath();
    ctx.fillStyle = COLORS.point;
    ctx.arc(point.x, point.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  });
}
