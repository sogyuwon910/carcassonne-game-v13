import { clamp, PHASE, TILE_SIZE } from "./config.js";

function darkenHexColor(color, factor = 0.82) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) return color;
  const channels = match.slice(1).map((value) => Math.round(Number.parseInt(value, 16) * factor));
  return `rgb(${channels.join(", ")})`;
}

export class BoardRenderer {
  constructor(canvas, { onMessage = () => {}, onGameAction = () => {} } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.onMessage = onMessage;
    this.onGameAction = onGameAction;
    this.game = null;
    this.images = new Map();
    this.camera = { x: 0, y: 0, zoom: 0.9 };
    this.hoveredCell = null;
    this.actionPreview = null;
    this.pointer = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.bindInput();
    this.resize();
    this.drawLoop();
  }

  async preload(definitions) {
    await Promise.all(definitions.map((definition) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => { this.images.set(definition.id, image); resolve(); };
      image.onerror = () => { this.images.set(definition.id, null); resolve(); };
      image.src = definition.imageUrl;
    })));
  }

  setGame(game) { this.game = game; this.actionPreview = null; this.centerBoard(); }

  // AI 로그/조언 미리보기는 화면에만 저장되며 GameEngine 상태에는 쓰지 않습니다.
  setActionPreview(preview) { this.actionPreview = preview ? { ...preview } : null; }
  clearActionPreview() { this.actionPreview = null; }

  resize() {
    const bounds = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.floor(bounds.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(bounds.height * dpr));
    this.canvas.style.width = `${bounds.width}px`;
    this.canvas.style.height = `${bounds.height}px`;
    this.cssWidth = bounds.width;
    this.cssHeight = bounds.height;
    this.dpr = dpr;
  }

  centerBoard() {
    if (!this.game) return;
    const bounds = this.game.board.getBounds();
    this.camera.x = -((bounds.minX + bounds.maxX) / 2) * TILE_SIZE * this.camera.zoom;
    this.camera.y = ((bounds.minY + bounds.maxY) / 2) * TILE_SIZE * this.camera.zoom;
  }

  zoomBy(factor, screenX = this.cssWidth / 2, screenY = this.cssHeight / 2) {
    const oldZoom = this.camera.zoom;
    const newZoom = clamp(oldZoom * factor, 0.42, 1.75);
    const worldX = (screenX - this.cssWidth / 2 - this.camera.x) / oldZoom;
    const worldY = (screenY - this.cssHeight / 2 - this.camera.y) / oldZoom;
    this.camera.zoom = newZoom;
    this.camera.x = screenX - this.cssWidth / 2 - worldX * newZoom;
    this.camera.y = screenY - this.cssHeight / 2 - worldY * newZoom;
  }

  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.cssWidth / 2 - this.camera.x) / this.camera.zoom,
      y: (screenY - this.cssHeight / 2 - this.camera.y) / this.camera.zoom,
    };
  }

  screenToCell(screenX, screenY) {
    const world = this.screenToWorld(screenX, screenY);
    return { x: Math.round(world.x / TILE_SIZE), y: -Math.round(world.y / TILE_SIZE), world };
  }

  bindInput() {
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.zoomBy(event.deltaY < 0 ? 1.12 : 0.89, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.pointer = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    });
    this.canvas.addEventListener("pointermove", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoveredCell = this.screenToCell(event.clientX - rect.left, event.clientY - rect.top);
      if (!this.pointer || this.pointer.id !== event.pointerId) return;
      const dx = event.clientX - this.pointer.x;
      const dy = event.clientY - this.pointer.y;
      if (Math.hypot(event.clientX - this.pointer.startX, event.clientY - this.pointer.startY) > 5) this.pointer.moved = true;
      if (this.pointer.moved) { this.camera.x += dx; this.camera.y += dy; }
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
    });
    this.canvas.addEventListener("pointerup", (event) => {
      if (this.pointer && !this.pointer.moved && this.pointer.button === 0) {
        const rect = this.canvas.getBoundingClientRect();
        this.handleClick(event.clientX - rect.left, event.clientY - rect.top);
      }
      this.pointer = null;
    });
    this.canvas.addEventListener("pointercancel", () => { this.pointer = null; });
  }

  handleClick(screenX, screenY) {
    if (!this.game || this.game.currentPlayer?.type === "ai") return;
    const cell = this.screenToCell(screenX, screenY);
    if (this.game.phase === PHASE.ROTATE_OR_PLACE) {
      if (!this.game.placeCurrentTile(cell.x, cell.y)) this.onMessage(this.game.turnMessage);
      else this.onGameAction("tile-placed");
      return;
    }
    if (this.game.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.game.lastPlaced) return;
    if (this.game.getTilePlacementOptions().some(({ x, y }) => x === cell.x && y === cell.y)) {
      this.game.repositionCurrentTile(cell.x, cell.y);
      this.onGameAction("tile-repositioned");
      return;
    }
    const world = cell.world;
    const placed = this.game.lastPlaced;
    const selectedMeeple = this.game.previewMeeple;
    if (selectedMeeple) {
      const x = placed.x * TILE_SIZE + (selectedMeeple.x - 0.5) * TILE_SIZE;
      const y = -placed.y * TILE_SIZE + (selectedMeeple.y - 0.5) * TILE_SIZE;
      if (Math.hypot(world.x - x, world.y - y) <= 18) {
        this.game.toggleMeeple(selectedMeeple.regionId);
        this.onGameAction("meeple-selected");
        return;
      }
    }
    const options = this.game.getMeepleOptions();
    const clicked = options.find((region) => {
      const x = placed.x * TILE_SIZE + (region.x - 0.5) * TILE_SIZE;
      const y = -placed.y * TILE_SIZE + (region.y - 0.5) * TILE_SIZE;
      return Math.hypot(world.x - x, world.y - y) <= 18;
    });
    if (clicked) {
      this.game.toggleMeeple(clicked.id);
      this.onGameAction("meeple-selected");
      return;
    }
    if (cell.x === placed.x && cell.y === placed.y) {
      this.game.recallCurrentTile();
      this.onGameAction("tile-recalled");
    }
  }

  drawLoop() { this.draw(); requestAnimationFrame(() => this.drawLoop()); }

  draw() {
    if (!this.cssWidth || !this.cssHeight) return;
    const ctx = this.context;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = "#304438";
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.save();
    ctx.translate(this.cssWidth / 2 + this.camera.x, this.cssHeight / 2 + this.camera.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    this.drawGrid(ctx);
    if (this.game) {
      this.drawCandidates(ctx);
      for (const placed of this.game.board.values().sort((a, b) => b.y - a.y || a.x - b.x)) this.drawPlacedTile(ctx, placed);
      this.drawLastPlacementHighlight(ctx);
      this.drawMeepleOptions(ctx);
      this.drawActionPreview(ctx);
    }
    ctx.restore();
  }

  drawGrid(ctx) {
    const worldWidth = this.cssWidth / this.camera.zoom;
    const worldHeight = this.cssHeight / this.camera.zoom;
    const centerWorldX = -this.camera.x / this.camera.zoom;
    const centerWorldY = -this.camera.y / this.camera.zoom;
    const minX = Math.floor((centerWorldX - worldWidth / 2) / TILE_SIZE) - 1;
    const maxX = Math.ceil((centerWorldX + worldWidth / 2) / TILE_SIZE) + 1;
    const minY = Math.floor((centerWorldY - worldHeight / 2) / TILE_SIZE) - 1;
    const maxY = Math.ceil((centerWorldY + worldHeight / 2) / TILE_SIZE) + 1;
    ctx.strokeStyle = "rgba(245,239,224,.075)";
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.beginPath();
    for (let x = minX; x <= maxX; x += 1) { ctx.moveTo(x * TILE_SIZE - TILE_SIZE / 2, minY * TILE_SIZE); ctx.lineTo(x * TILE_SIZE - TILE_SIZE / 2, maxY * TILE_SIZE); }
    for (let y = minY; y <= maxY; y += 1) { ctx.moveTo(minX * TILE_SIZE, y * TILE_SIZE - TILE_SIZE / 2); ctx.lineTo(maxX * TILE_SIZE, y * TILE_SIZE - TILE_SIZE / 2); }
    ctx.stroke();
  }

  drawCandidates(ctx) {
    const tile = this.game.currentTile ?? (
      this.game.phase === PHASE.PLACE_MEEPLE_OR_SKIP ? this.game.lastPlaced?.tile : null
    );
    if (!tile) return;
    const valid = this.game.getTilePlacementOptions();
    const pulse = 0.55 + Math.sin(performance.now() / 330) * 0.13;
    for (const { x, y } of valid) {
      const centerX = x * TILE_SIZE;
      const centerY = -y * TILE_SIZE;
      ctx.fillStyle = `rgba(220,195,119,${pulse})`;
      ctx.strokeStyle = "rgba(252,234,176,.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.fillRect(centerX - 44, centerY - 44, 88, 88);
      ctx.strokeRect(centerX - 44, centerY - 44, 88, 88);
      ctx.setLineDash([]);
    }
    if (this.hoveredCell && valid.some((item) => item.x === this.hoveredCell.x && item.y === this.hoveredCell.y)) {
      ctx.save();
      ctx.globalAlpha = 0.62;
      this.drawTileImage(ctx, tile, this.hoveredCell.x * TILE_SIZE, -this.hoveredCell.y * TILE_SIZE);
      ctx.restore();
    }
  }

  drawTileImage(ctx, tile, centerX, centerY) {
    const image = this.images.get(tile.definition.id);
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(tile.rotation * Math.PI / 2);
    if (image) ctx.drawImage(image, -47, -47, 94, 94);
    else {
      ctx.fillStyle = "#d6c79d";
      ctx.fillRect(-47, -47, 94, 94);
      ctx.fillStyle = "#3b4d43";
      ctx.font = "700 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`TILE ${tile.definition.id}`, 0, 4);
    }
    ctx.restore();
  }

  drawPlacedTile(ctx, placed) {
    const x = placed.x * TILE_SIZE;
    const y = -placed.y * TILE_SIZE;
    ctx.fillStyle = "rgba(3,10,7,.24)";
    ctx.fillRect(x - 43, y - 40, 94, 94);
    this.drawTileImage(ctx, placed.tile, x, y);
    for (const meeple of placed.meeples) {
      const player = this.game.players.find((item) => item.id === meeple.playerId);
      this.drawMeeple(
        ctx,
        x + (meeple.x - 0.5) * TILE_SIZE,
        y + (meeple.y - 0.5) * TILE_SIZE,
        player?.color ?? "#777",
        meeple.playerId + 1,
      );
    }
  }

  drawMeeple(ctx, x, y, color, teamNumber) {
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = "rgba(0,0,0,.65)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = darkenHexColor(color);
    ctx.strokeStyle = "rgba(18,18,18,.95)";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, -8, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(-8, -2, 16, 17, 5); ctx.fill(); ctx.stroke();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, -8, 5.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(-8, -2, 16, 17, 5); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,.9)";
    ctx.lineWidth = 2.5;
    ctx.font = "900 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(String(teamNumber), 0, 7);
    ctx.fillText(String(teamNumber), 0, 7);
    ctx.restore();
  }

  drawLastPlacementHighlight(ctx) {
    const placement = this.game.lastPlacement;
    if (!placement) return;
    const player = this.game.players.find((item) => item.id === placement.playerId);
    const color = player?.color ?? "#f6d778";
    const x = placement.x * TILE_SIZE;
    const y = -placement.y * TILE_SIZE;

    ctx.save();
    ctx.translate(x, y);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(20,25,22,.92)";
    ctx.lineWidth = 7;
    ctx.strokeRect(-48, -48, 96, 96);
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(-47, -47, 94, 94);
    ctx.restore();
  }

  drawMeepleOptions(ctx) {
    if (this.game.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.game.lastPlaced || this.game.currentPlayer.type === "ai") return;
    const placed = this.game.lastPlaced;
    for (const region of this.game.getMeepleOptions()) {
      const x = placed.x * TILE_SIZE + (region.x - 0.5) * TILE_SIZE;
      const y = -placed.y * TILE_SIZE + (region.y - 0.5) * TILE_SIZE;
      ctx.fillStyle = "rgba(248,224,147,.76)";
      ctx.strokeStyle = "#fff1bc";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#594a2d";
      ctx.font = "700 10px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("+", x, y);
    }
  }

  // 후보 타일, 회전, 미플 위치와 설명을 반투명 오버레이로 그립니다.
  drawActionPreview(ctx) {
    const preview = this.actionPreview;
    if (!preview || !this.game) return;
    const definition = this.game.definitionMap.get(preview.tileId)
      ?? this.game.currentTile?.definition
      ?? this.game.lastPlaced?.tile.definition;
    if (!definition) return;
    const tile = { definition, rotation: preview.rotation ?? 0 };
    const centerX = preview.x * TILE_SIZE;
    const centerY = -preview.y * TILE_SIZE;
    const accent = preview.source === "advice" ? "#7de1ff" : "#f7d77d";

    ctx.save();
    ctx.globalAlpha = 0.67;
    this.drawTileImage(ctx, tile, centerX, centerY);
    ctx.globalAlpha = 1;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.setLineDash([10, 5]);
    ctx.strokeRect(centerX - 49, centerY - 49, 98, 98);
    ctx.setLineDash([]);
    ctx.shadowColor = "transparent";

    if (preview.regionId) {
      const region = definition.getRegion(preview.featureType, preview.regionId, preview.rotation);
      if (region) {
        const meepleX = centerX + (region.x - 0.5) * TILE_SIZE;
        const meepleY = centerY + (region.y - 0.5) * TILE_SIZE;
        ctx.fillStyle = accent;
        ctx.strokeStyle = "#17231f";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(meepleX, meepleY, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#17231f";
        ctx.font = "900 13px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("M", meepleX, meepleY + 1);
      }
    }

    const lines = [
      `좌표 (${preview.x}, ${preview.y}) · ${preview.rotation * 90}°`,
      `미플: ${preview.featureLabel}`,
    ];
    ctx.font = "700 11px sans-serif";
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 18;
    const labelX = centerX - 47;
    const labelY = centerY - 78;
    ctx.fillStyle = "rgba(15,27,22,.94)";
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, width, 42, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f8f2e5";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    lines.forEach((line, index) => ctx.fillText(line, labelX + 9, labelY + 16 + index * 15));
    ctx.restore();
  }
}
