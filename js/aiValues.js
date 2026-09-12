import { coordinateKey, FEATURE } from "./config.js";
import { majorityWinners, traceFeature, traceMonastery } from "./featureGraph.js";
import { completedScore, estimateEndScoreForPlayer, incompleteScore } from "./scoring.js";
import { TileInstance } from "./tile.js";

function structuresOwnedBy(board, playerId) {
  const structures = [];
  const visited = new Set();
  for (const placed of board.values()) {
    for (const meeple of placed.meeples.filter((item) => item.playerId === playerId)) {
      const structure = meeple.type === FEATURE.MONASTERY
        ? traceMonastery(board, placed.x, placed.y)
        : traceFeature(board, placed.x, placed.y, meeple.type, meeple.regionId);
      if (!structure || structure.complete || visited.has(structure.canonicalKey)) continue;
      visited.add(structure.canonicalKey);
      if (majorityWinners(structure.meeples).includes(playerId)) structures.push(structure);
    }
  }
  return structures;
}

// 같은 물리 타일이 여러 회전으로 들어맞아도 한 장으로만 세어 기존 F(S) 계산을 유지합니다.
export function countTilesForPosition(game, position) {
  let matchingTiles = 0;
  for (const remainingTile of game.deck) {
    const signatures = new Set();
    let canUse = false;
    for (let rotation = 0; rotation < 4; rotation += 1) {
      const signature = remainingTile.definition.getRotationSignature(rotation);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      const candidate = new TileInstance(remainingTile.definition, rotation);
      if (game.board.canPlace(candidate, position.x, position.y)) { canUse = true; break; }
    }
    if (canUse) matchingTiles += 1;
  }
  return matchingTiles;
}

// 미완성 구조물에 필요한 각 위치의 단순 곱 확률입니다. 기존 AI 공식을 그대로 보존합니다.
export function completionProbability(game, structure) {
  const positions = structure.type === FEATURE.MONASTERY
    ? structure.emptyPositions
    : [...new Map(structure.openEnds.map((end) => [
      coordinateKey(end.targetX, end.targetY),
      { x: end.targetX, y: end.targetY },
    ])).values()];
  if (!positions.length) return { probability: 1, positions: [] };
  const remainingCount = game.deck.length;
  if (!remainingCount) {
    return {
      probability: 0,
      positions: positions.map((position) => ({ ...position, matches: 0, probability: 0 })),
    };
  }
  let probability = 1;
  const details = positions.map((position) => {
    const matches = countTilesForPosition(game, position);
    const positionProbability = matches / remainingCount;
    probability *= positionProbability;
    return { ...position, matches, probability: positionProbability };
  });
  return { probability, positions: details };
}

// C_p(S): 이미 완성 구조물 등으로 실제 획득한 점수입니다.
export function calculateCompletedScoreValue(game, playerId) {
  return game.players.find((item) => item.id === playerId)?.score ?? 0;
}

// N_p(S): 지금 게임이 끝난다고 가정할 때 받는 미완성 구조물 점수입니다.
export function calculateIncompleteScoreValue(game, playerId) {
  return estimateEndScoreForPlayer(game.board, playerId);
}

// I_p(S) = C_p(S) + N_p(S). 분리 전 calculateImmediateValue와 같은 결과입니다.
export function calculateImmediateValue(game, playerId) {
  return calculateCompletedScoreValue(game, playerId)
    + calculateIncompleteScoreValue(game, playerId);
}

// F_p(S): 미완성 구조물의 (완성 시 추가 점수 × 단순 완성 확률) 합입니다.
export function calculateFutureValue(game, playerId) {
  let total = 0;
  const details = [];
  for (const structure of structuresOwnedBy(game.board, playerId)) {
    const currentScore = incompleteScore(structure);
    const fullScore = completedScore(structure);
    const additionalScore = Math.max(0, fullScore - currentScore);
    const probabilityResult = completionProbability(game, structure);
    const value = additionalScore * probabilityResult.probability;
    total += value;
    details.push({
      key: structure.canonicalKey,
      type: structure.type,
      currentScore,
      fullScore,
      additionalScore,
      probability: probabilityResult.probability,
      openEnds: structure.openEnds ?? [],
      positions: probabilityResult.positions,
      value,
    });
  }
  return { total, details };
}

export function calculateScoreComponents(game, playerId) {
  const completed = calculateCompletedScoreValue(game, playerId);
  const incomplete = calculateIncompleteScoreValue(game, playerId);
  const immediate = completed + incomplete;
  const futureResult = calculateFutureValue(game, playerId);
  return {
    completed,
    incomplete,
    immediate,
    future: futureResult.total,
    featureDetails: futureResult.details,
  };
}

// 현재 타일이 이미 덱에서 빠진 상태를 기준으로 이번 턴을 포함합니다.
export function calculateRemainingOwnTurns(game) {
  const playerCount = game.players.length;
  return playerCount > 0 ? 1 + Math.floor(game.deck.length / playerCount) : 0;
}

// S_i는 점수 처리와 미플 회수가 끝난 상태입니다. 배치한 한 개를 보정해 자기 회수분만 구합니다.
export function calculateReturnedMeeples(beforeMeeples, simulatedGame, playerId, action) {
  const afterMeeples = simulatedGame.players.find((player) => player.id === playerId)?.meeples ?? 0;
  return Math.max(0, afterMeeples - beforeMeeples + (action.regionId ? 1 : 0));
}

export function calculateActionMetrics(originalGame, simulatedGame, action, playerId) {
  const metrics = calculateScoreComponents(simulatedGame, playerId);
  const beforeMeeples = originalGame.players.find((player) => player.id === playerId)?.meeples ?? 0;
  const meeplesAfter = simulatedGame.players.find((player) => player.id === playerId)?.meeples ?? 0;
  return {
    ...metrics,
    meeplesAfter,
    returnedMeeples: calculateReturnedMeeples(beforeMeeples, simulatedGame, playerId, action),
  };
}

// 기존 외부 API가 기대하는 기본 V(S) 평가입니다.
export function evaluateState(game, playerId) {
  const metrics = calculateScoreComponents(game, playerId);
  return { ...metrics, value: metrics.immediate + metrics.future };
}
