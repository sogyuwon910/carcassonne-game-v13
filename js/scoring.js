import { FEATURE } from "./config.js";
import { majorityWinners, removeStructureMeeples, traceFeature, traceMonastery } from "./featureGraph.js";

export function completedScore(structure) {
  if (structure.type === FEATURE.ROAD) return structure.tileKeys.size;
  if (structure.type === FEATURE.CITY) return structure.tileKeys.size * 2 + structure.shields * 2;
  if (structure.type === FEATURE.MONASTERY) return 9;
  return 0;
}

export function incompleteScore(structure) {
  if (structure.type === FEATURE.ROAD) return structure.tileKeys.size;
  if (structure.type === FEATURE.CITY) return structure.tileKeys.size + structure.shields;
  if (structure.type === FEATURE.MONASTERY) return 1 + structure.neighbors;
  return 0;
}

function award(board, players, structure, score) {
  const winners = majorityWinners(structure.meeples);
  for (const playerId of winners) players.find((player) => player.id === playerId).score += score;
  for (const meeple of structure.meeples) players.find((player) => player.id === meeple.playerId).meeples += 1;
  removeStructureMeeples(board, structure);
  return { feature: structure.type, score, winners, returnedMeeples: structure.meeples.length };
}

// 방금 놓은 타일 때문에 완성될 수 있는 구조물만 검사해 중복 지급을 막습니다.
export function scoreCompletedAround(board, players, x, y, scoredFeatureKeys) {
  const placed = board.get(x, y);
  if (!placed) return [];
  const results = [];
  const checked = new Set();
  for (const region of placed.tile.regions.filter((item) => [FEATURE.CITY, FEATURE.ROAD].includes(item.type))) {
    const structure = traceFeature(board, x, y, region.type, region.id);
    if (checked.has(structure.canonicalKey)) continue;
    checked.add(structure.canonicalKey);
    if (structure.complete && !scoredFeatureKeys.has(structure.canonicalKey)) {
      scoredFeatureKeys.add(structure.canonicalKey);
      results.push(award(board, players, structure, completedScore(structure)));
    }
  }

  // 새 타일은 자신과 주변 여덟 칸의 수도원을 완성할 수 있습니다.
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const monastery = traceMonastery(board, x + dx, y + dy);
      if (monastery?.complete && !scoredFeatureKeys.has(monastery.canonicalKey)) {
        scoredFeatureKeys.add(monastery.canonicalKey);
        results.push(award(board, players, monastery, completedScore(monastery)));
      }
    }
  }
  return results;
}

// 덱이 끝났을 때 미플이 놓인 모든 미완성 구조물을 정확히 한 번 계산합니다.
export function scoreGameEnd(board, players) {
  const visited = new Set();
  const results = [];
  for (const placed of board.values()) {
    for (const meeple of [...placed.meeples]) {
      const structure = meeple.type === FEATURE.MONASTERY
        ? traceMonastery(board, placed.x, placed.y)
        : traceFeature(board, placed.x, placed.y, meeple.type, meeple.regionId);
      if (!structure || visited.has(structure.canonicalKey)) continue;
      visited.add(structure.canonicalKey);
      results.push(award(board, players, structure, incompleteScore(structure)));
    }
  }
  return results;
}

// AI의 I(S) 계산에 사용하는 비파괴 최종 점수 예상치입니다.
export function estimateEndScoreForPlayer(board, playerId) {
  const visited = new Set();
  let total = 0;
  for (const placed of board.values()) {
    for (const meeple of placed.meeples.filter((item) => item.playerId === playerId)) {
      const structure = meeple.type === FEATURE.MONASTERY
        ? traceMonastery(board, placed.x, placed.y)
        : traceFeature(board, placed.x, placed.y, meeple.type, meeple.regionId);
      if (!structure || visited.has(structure.canonicalKey) || structure.complete) continue;
      visited.add(structure.canonicalKey);
      if (majorityWinners(structure.meeples).includes(playerId)) total += incompleteScore(structure);
    }
  }
  return total;
}
