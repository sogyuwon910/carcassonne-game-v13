import { FEATURE } from "./config.js";

// 방향 번호를 시계 방향으로 회전합니다. 1(북) → 2(동) 순서입니다.
export function rotateDirection(direction, rotation) {
  return ((Number(direction) - 1 + rotation) % 4) + 1;
}

function directionAnchor(direction) {
  return {
    1: { x: 0.5, y: 0.2 }, 2: { x: 0.8, y: 0.5 },
    3: { x: 0.5, y: 0.8 }, 4: { x: 0.2, y: 0.5 },
  }[direction];
}

// tiles.json 한 항목을 다루는 읽기 전용 정의입니다.
export class TileDefinition {
  constructor(raw) {
    if (!raw?.id || !raw?.edges) throw new Error("타일 ID 또는 가장자리 정보가 없습니다.");
    this.id = Number(raw.id);
    this.count = Number(raw.count ?? 0);
    this.drawCount = Number(raw.draw_count ?? raw.count ?? 0);
    this.startCount = Number(raw.start_count ?? 0);
    this.edges = Object.fromEntries([1, 2, 3, 4].map((d) => [d, raw.edges[String(d)]]));
    if ([1, 2, 3, 4].some((d) => !["F", "R", "C"].includes(this.edges[d]))) {
      throw new Error(`TILE_${String(this.id).padStart(2, "0")}의 지형 코드가 올바르지 않습니다.`);
    }
    this.cityGroups = (raw.city_groups ?? []).map((group) => group.map(Number));
    this.roadGroups = (raw.road_groups ?? []).map((group) => group.map(Number));
    this.monastery = Boolean(raw.monastery);
    this.shield = Boolean(raw.shield);
    this.village = Boolean(raw.village);
    this.roadTerminal = raw.road_terminal ?? {};
    this.imageUrl = `/assets/tiles/tile_${String(this.id).padStart(2, "0")}.png`;
  }

  getEdge(direction, rotation = 0) {
    const original = ((direction - 1 - rotation + 8) % 4) + 1;
    return this.edges[original];
  }

  getEdges(rotation = 0) {
    return [1, 2, 3, 4].map((direction) => this.getEdge(direction, rotation));
  }

  getGroups(type, rotation = 0) {
    const groups = type === FEATURE.CITY ? this.cityGroups : this.roadGroups;
    return groups.map((group) => group.map((direction) => rotateDirection(direction, rotation)));
  }

  // 화면상 미플 위치도 논리 방향과 함께 회전된 결과에서 계산합니다.
  getRegions(rotation = 0) {
    const regions = [];
    for (const type of [FEATURE.CITY, FEATURE.ROAD]) {
      this.getGroups(type, rotation).forEach((directions, index) => {
        const anchors = directions.map(directionAnchor);
        const average = anchors.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
        let x = average.x / anchors.length;
        let y = average.y / anchors.length;
        if (directions.length > 1) {
          x = 0.5 + (x - 0.5) * 0.7;
          y = 0.5 + (y - 0.5) * 0.7;
        }
        regions.push({ id: `${type}-${index}`, type, directions, x, y });
      });
    }
    if (this.monastery) regions.push({ id: "monastery-0", type: FEATURE.MONASTERY, directions: [], x: 0.5, y: 0.5 });
    return regions;
  }

  getRegion(type, regionId, rotation = 0) {
    return this.getRegions(rotation).find((region) => region.type === type && region.id === regionId) ?? null;
  }

  getRegionAtEdge(type, direction, rotation = 0) {
    return this.getRegions(rotation).find((region) => region.type === type && region.directions.includes(direction)) ?? null;
  }

  // 대칭 타일의 중복 회전을 줄이기 위한 논리 서명입니다.
  getRotationSignature(rotation = 0) {
    const groups = [FEATURE.CITY, FEATURE.ROAD].map((type) =>
      this.getGroups(type, rotation).map((group) => [...group].sort().join("")).sort().join(";")
    );
    return `${this.getEdges(rotation).join("")}|${groups.join("|")}|${this.monastery}`;
  }
}

// 덱의 물리적인 타일 한 장입니다. 같은 정의도 각각 독립 회전 상태를 가집니다.
export class TileInstance {
  constructor(definition, rotation = 0) { this.definition = definition; this.rotation = rotation % 4; }
  rotate() { this.rotation = (this.rotation + 1) % 4; return this.rotation; }
  clone() { return new TileInstance(this.definition, this.rotation); }
  get edgeList() { return this.definition.getEdges(this.rotation); }
  get imageUrl() { return this.definition.imageUrl; }
  get regions() { return this.definition.getRegions(this.rotation); }
}

export function parseTileDefinitions(data) {
  if (!data || !Array.isArray(data.tiles)) throw new Error("tiles.json에 tiles 배열이 없습니다.");
  const definitions = data.tiles.map((raw) => new TileDefinition(raw));
  if (!definitions.length) throw new Error("사용할 수 있는 타일이 없습니다.");
  return definitions;
}
