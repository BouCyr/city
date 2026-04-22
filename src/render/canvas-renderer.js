const COLORS = {
  background: "#f8f6f1",
  grid: "rgba(24, 33, 38, 0.06)",
  road: "#1b2830",
  district: {
    civic: "#d9c4a0",
    market: "#e7b88c",
    garden: "#b5ccb0",
    industrial: "#bca99d",
    residential: "#d8d3c2",
  },
  block: "rgba(255, 255, 255, 0.62)",
  water: "#7cb7c9",
  landmark: "#d66b3d",
  label: "#40525c",
};

export function clearCanvas(canvas, message) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = COLORS.label;
  ctx.font = "20px IBM Plex Mono";
  ctx.fillText(message, 28, 40);
}

export function drawCityMap(canvas, map) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  clearBase(ctx, size);
  drawWater(ctx, size, map.water);
  drawDistricts(ctx, size, map.districts);
  drawRoads(ctx, size, map.roads);
  drawBlocks(ctx, size, map.blocks);
  drawLandmarks(ctx, size, map.landmarks);
  drawLabels(ctx, size, map);
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

function drawWater(ctx, size, water) {
  if (water.type === "none") {
    return;
  }

  ctx.fillStyle = COLORS.water;
  if (water.type === "coast") {
    const depth = size * water.depth;
    if (water.side === "north") ctx.fillRect(0, 0, size, depth);
    if (water.side === "south") ctx.fillRect(0, size - depth, size, depth);
    if (water.side === "east") ctx.fillRect(size - depth, 0, depth, size);
    if (water.side === "west") ctx.fillRect(0, 0, depth, size);
    return;
  }

  ctx.beginPath();
  water.bends.forEach((bend, index) => {
    const x = bend.x * size;
    const y = bend.y * size;
    if (index === 0) {
      ctx.moveTo(x, y);
      return;
    }
    ctx.lineTo(x, y);
  });
  ctx.lineWidth = size * 0.1;
  ctx.strokeStyle = COLORS.water;
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawDistricts(ctx, size, districts) {
  districts.forEach((district) => {
    ctx.beginPath();
    ctx.fillStyle = COLORS.district[district.tone];
    ctx.globalAlpha = 0.78;
    ctx.arc(district.x * size, district.y * size, district.radius * size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
}

function drawRoads(ctx, size, roads) {
  roads.forEach((road) => {
    ctx.beginPath();
    ctx.strokeStyle = COLORS.road;
    ctx.lineWidth = road.weight * 4;
    ctx.moveTo(road.x1 * size, road.y1 * size);
    ctx.lineTo(road.x2 * size, road.y2 * size);
    ctx.stroke();
  });
}

function drawBlocks(ctx, size, blocks) {
  ctx.fillStyle = COLORS.block;
  blocks.forEach((block) => {
    ctx.save();
    ctx.translate(block.x * size, block.y * size);
    ctx.rotate(block.rotation);
    ctx.fillRect(-(block.w * size) / 2, -(block.h * size) / 2, block.w * size, block.h * size);
    ctx.restore();
  });
}

function drawLandmarks(ctx, size, landmarks) {
  landmarks.forEach((landmark) => {
    ctx.beginPath();
    ctx.fillStyle = COLORS.landmark;
    ctx.arc(landmark.x * size, landmark.y * size, landmark.size * size, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawLabels(ctx, size, map) {
  ctx.fillStyle = COLORS.label;
  ctx.font = "15px IBM Plex Mono";
  ctx.fillText(`seed: ${map.seed}`, 24, size - 28);
  ctx.fillText(map.profile, 24, size - 52);
}
