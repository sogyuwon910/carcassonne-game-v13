import { coordinateKey, DIRECTIONS, FEATURE, nodeKey } from "./config.js";

// 성 또는 도로의 한 연결 구조물을 보드 전체에서 추적합니다.
// 타일 내부 그룹과 인접 타일 연결을 같은 방식으로 따라가므로 합쳐지는 구조물도 처리합니다.
export function traceFeature(board, startX, startY, type, startRegionId) {
  if (![FEATURE.CITY, FEATURE.ROAD].includes(type)) throw new Error("성 또는 도로만 연결 탐색할 수 있습니다.");
  const queue = [{ x: startX, y: startY, regionId: startRegionId }];
  const visited = new Set();
  const nodes = [];
  const openEnds = [];
  const tileKeys = new Set();
  const meeples = [];
  let shields = 0;

  while (queue.length) {
    const current = queue.shift();
    const currentKey = nodeKey(current.x, current.y, current.regionId);
    if (visited.has(currentKey)) continue;
    const placed = board.get(current.x, current.y);
    if (!placed) continue;
    const region = placed.tile.definition.getRegion(type, current.regionId, placed.tile.rotation);
    if (!region) continue;
    visited.add(currentKey);
    nodes.push({ ...current, region });

    const tileKey = coordinateKey(current.x, current.y);
    if (!tileKeys.has(tileKey)) {
      tileKeys.add(tileKey);
      if (type === FEATURE.CITY && placed.tile.definition.shield) shields += 1;
    }
    meeples.push(...placed.meeples.filter((meeple) => meeple.type === type && meeple.regionId === current.regionId));

    for (const direction of region.directions) {
      const vector = DIRECTIONS[direction];
      const neighborX = current.x + vector.dx;
      const neighborY = current.y + vector.dy;
      const neighbor = board.get(neighborX, neighborY);
      if (!neighbor) {
        openEnds.push({ x: current.x, y: current.y, direction, targetX: neighborX, targetY: neighborY });
        continue;
      }
      const neighborRegion = neighbor.tile.definition.getRegionAtEdge(type, vector.opposite, neighbor.tile.rotation);
      if (neighborRegion) queue.push({ x: neighborX, y: neighborY, regionId: neighborRegion.id });
    }
  }

  const canonicalKey = `${type}:${nodes.map((node) => nodeKey(node.x, node.y, node.regionId)).sort().join("|")}`;
  return { type, nodes, openEnds, meeples, shields, tileKeys, canonicalKey, complete: openEnds.length === 0 };
}

export function traceMonastery(board, x, y) {
  const placed = board.get(x, y);
  if (!placed?.tile.definition.monastery) return null;
  let neighbors = 0;
  const emptyPositions = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      if (board.has(x + dx, y + dy)) neighbors += 1;
      else emptyPositions.push({ x: x + dx, y: y + dy });
    }
  }
  const regionId = "monastery-0";
  return {
    type: FEATURE.MONASTERY, nodes: [{ x, y, regionId }],
    meeples: placed.meeples.filter((meeple) => meeple.type === FEATURE.MONASTERY),
    neighbors, emptyPositions, tileKeys: new Set([coordinateKey(x, y)]), shields: 0,
    canonicalKey: `${FEATURE.MONASTERY}:${x},${y}`, complete: neighbors === 8,
  };
}

export function getStructureForRegion(board, x, y, region) {
  return region.type === FEATURE.MONASTERY
    ? traceMonastery(board, x, y)
    : traceFeature(board, x, y, region.type, region.id);
}

// 새 타일 위에서 현재 플레이어가 선택할 수 있는 미플 영역만 반환합니다.
export function getLegalMeepleOptions(board, x, y, remainingMeeples) {
  if (remainingMeeples <= 0) return [];
  const placed = board.get(x, y);
  if (!placed) return [];
  return placed.tile.regions.filter((region) => {
    if (![FEATURE.CITY, FEATURE.ROAD, FEATURE.MONASTERY].includes(region.type)) return false;
    const structure = getStructureForRegion(board, x, y, region);
    return structure && structure.meeples.length === 0;
  });
}

export function countMeeplesByPlayer(meeples) {
  const counts = new Map();
  for (const meeple of meeples) counts.set(meeple.playerId, (counts.get(meeple.playerId) ?? 0) + 1);
  return counts;
}

export function majorityWinners(meeples) {
  const counts = countMeeplesByPlayer(meeples);
  const highest = Math.max(0, ...counts.values());
  return highest === 0 ? [] : [...counts.entries()].filter(([, count]) => count === highest).map(([playerId]) => playerId);
}

export function removeStructureMeeples(board, structure) {
  for (const node of structure.nodes) {
    const placed = board.get(node.x, node.y);
    if (!placed) continue;
    placed.meeples = placed.meeples.filter((meeple) => !(meeple.type === structure.type && meeple.regionId === node.regionId));
  }
}

