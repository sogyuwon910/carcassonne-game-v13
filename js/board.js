import { coordinateKey, DIRECTIONS } from "./config.js";
import { TileInstance } from "./tile.js";

// 무한 격자 보드입니다. 실제로 놓인 좌표만 Map에 저장합니다.
export class Board {
  constructor() { this.tiles = new Map(); }
  get size() { return this.tiles.size; }
  get(x, y) { return this.tiles.get(coordinateKey(x, y)) ?? null; }
  has(x, y) { return this.tiles.has(coordinateKey(x, y)); }

  place(tile, x, y) {
    if (this.has(x, y)) throw new Error("이미 타일이 놓인 칸입니다.");
    const placed = { x, y, tile, meeples: [] };
    this.tiles.set(coordinateKey(x, y), placed);
    return placed;
  }

  remove(x, y) { this.tiles.delete(coordinateKey(x, y)); }
  values() { return [...this.tiles.values()]; }

  canPlace(tile, x, y, ignored = null) {
    const isIgnored = (targetX, targetY) => ignored?.x === targetX && ignored?.y === targetY;
    if (this.has(x, y) && !isIgnored(x, y)) return false;
    let neighborCount = 0;
    for (const direction of [1, 2, 3, 4]) {
      const vector = DIRECTIONS[direction];
      const neighborX = x + vector.dx;
      const neighborY = y + vector.dy;
      const neighbor = isIgnored(neighborX, neighborY) ? null : this.get(neighborX, neighborY);
      if (!neighbor) continue;
      neighborCount += 1;
      const ownEdge = tile.definition.getEdge(direction, tile.rotation);
      const neighborEdge = neighbor.tile.definition.getEdge(vector.opposite, neighbor.tile.rotation);
      if (ownEdge !== neighborEdge) return false;
    }
    return neighborCount > 0;
  }

  getCandidateCoordinates(ignored = null) {
    const isIgnored = (x, y) => ignored?.x === x && ignored?.y === y;
    const candidates = new Map();
    for (const placed of this.tiles.values()) {
      if (isIgnored(placed.x, placed.y)) continue;
      for (const direction of [1, 2, 3, 4]) {
        const vector = DIRECTIONS[direction];
        const x = placed.x + vector.dx;
        const y = placed.y + vector.dy;
        if (!this.has(x, y) || isIgnored(x, y)) candidates.set(coordinateKey(x, y), { x, y });
      }
    }
    return [...candidates.values()];
  }

  getValidCoordinates(tile, ignored = null) {
    return this.getCandidateCoordinates(ignored).filter(({ x, y }) => this.canPlace(tile, x, y, ignored));
  }

  getAllLegalPlacements(tile) {
    const placements = [];
    const seenRotations = new Set();
    for (let rotation = 0; rotation < 4; rotation += 1) {
      const signature = tile.definition.getRotationSignature(rotation);
      if (seenRotations.has(signature)) continue;
      seenRotations.add(signature);
      const rotated = new TileInstance(tile.definition, rotation);
      for (const { x, y } of this.getValidCoordinates(rotated)) placements.push({ x, y, rotation });
    }
    return placements;
  }

  getBounds() {
    if (!this.tiles.size) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const placed = this.values();
    return {
      minX: Math.min(...placed.map((item) => item.x)), maxX: Math.max(...placed.map((item) => item.x)),
      minY: Math.min(...placed.map((item) => item.y)), maxY: Math.max(...placed.map((item) => item.y)),
    };
  }

  clone() {
    const copy = new Board();
    for (const placed of this.tiles.values()) {
      const target = copy.place(placed.tile.clone(), placed.x, placed.y);
      target.meeples = placed.meeples.map((meeple) => ({ ...meeple }));
    }
    return copy;
  }
}
