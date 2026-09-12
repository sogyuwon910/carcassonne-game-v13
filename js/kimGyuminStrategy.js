import { FEATURE } from "./config.js";
import { completionProbability, calculateActionMetrics, calculateFutureValue, calculateRemainingOwnTurns } from "./aiValues.js";
import { countMeeplesByPlayer, traceFeature } from "./featureGraph.js";
import { completedScore, incompleteScore } from "./scoring.js";

const VALUE_EPSILON = 1e-9;
const ZERO_EPSILON = 1e-12;

// 명세의 P_0는 +y가 아래쪽인 좌표로 보존합니다. 실제 보드 적용 시 y 부호를 변환합니다.
export const BASE_JOIN_PATTERNS = Object.freeze([
  Object.freeze({ dx: 1, dy: 1, targetShape: "C###", actionShape: "###C" }),
  Object.freeze({ dx: 1, dy: 1, targetShape: "#C##", actionShape: "##C#" }),
  Object.freeze({ dx: 2, dy: 0, targetShape: "#C##", actionShape: "###C" }),
  Object.freeze({ dx: 0, dy: 2, targetShape: "C###", actionShape: "##C#" }),
  Object.freeze({ dx: 1, dy: 0, targetShape: "C###", actionShape: "C###" }),
  Object.freeze({ dx: 1, dy: 0, targetShape: "#C##", actionShape: "#C##" }),
  Object.freeze({ dx: 0, dy: 1, targetShape: "##C#", actionShape: "##C#" }),
  Object.freeze({ dx: 0, dy: 1, targetShape: "###C", actionShape: "###C" }),
]);

export function rotateShape90(shape) {
  return `${shape[3]}${shape[0]}${shape[1]}${shape[2]}`;
}

// 프로젝트는 북쪽이 +y이므로 시계 방향 90도는 (dx,dy) -> (dy,-dx)입니다.
export function rotatePosition90(dx, dy) {
  return { dx: dy, dy: -dx };
}

export function rotatePattern90(pattern) {
  const position = rotatePosition90(pattern.dx, pattern.dy);
  return {
    ...position,
    targetShape: rotateShape90(pattern.targetShape),
    actionShape: rotateShape90(pattern.actionShape),
  };
}

function patternKey(pattern) {
  return `${pattern.dx},${pattern.dy}:${pattern.targetShape}:${pattern.actionShape}`;
}

export function generateJoinPatterns(basePatterns = BASE_JOIN_PATTERNS) {
  const patterns = new Map();
  for (const base of basePatterns) {
    // 명세 좌표(+y 아래)를 게임 좌표(+y 위)로 한 번 변환한 뒤 회전합니다.
    let rotated = { ...base, dy: -base.dy };
    for (let rotation = 0; rotation < 4; rotation += 1) {
      patterns.set(patternKey(rotated), Object.freeze({ ...rotated, rotation }));
      rotated = rotatePattern90(rotated);
    }
  }
  return Object.freeze([...patterns.values()]);
}

export const JOIN_PATTERNS = generateJoinPatterns();
const JOIN_PATTERN_MAP = new Map(JOIN_PATTERNS.map((pattern) => [patternKey(pattern), pattern]));

export function cityShapeForTile(tile, rotation = tile.rotation) {
  return tile.definition.getEdges(rotation).map((edge) => edge === "C" ? "C" : "#").join("");
}

export function calculateCityFutureValue(game, structure) {
  if (!structure || structure.type !== FEATURE.CITY || structure.complete) return 0;
  const additionalScore = Math.max(0, completedScore(structure) - incompleteScore(structure));
  return additionalScore * completionProbability(game, structure).probability;
}

function plainCityDescriptor(game, structure, playerId) {
  const counts = countMeeplesByPlayer(structure.meeples);
  const opponentCounts = game.players
    .filter((player) => player.id !== playerId)
    .map((player) => ({ playerId: player.id, playerName: player.name, count: counts.get(player.id) ?? 0 }));
  const selfMeeples = counts.get(playerId) ?? 0;
  const maxOpponentMeeples = Math.max(0, ...opponentCounts.map((item) => item.count));
  return {
    key: structure.canonicalKey,
    nodes: structure.nodes.map((node) => ({ x: node.x, y: node.y, regionId: node.regionId })),
    tileCoordinates: [...new Map(structure.nodes.map((node) => [`${node.x},${node.y}`, { x: node.x, y: node.y }])).values()],
    selfMeeples,
    maxOpponentMeeples,
    opponentCounts,
    future: calculateCityFutureValue(game, structure),
  };
}

export function findJoinableCities(game, playerId) {
  const visited = new Set();
  const cities = [];
  for (const placed of game.board.values()) {
    for (const region of placed.tile.regions.filter((item) => item.type === FEATURE.CITY)) {
      const structure = traceFeature(game.board, placed.x, placed.y, FEATURE.CITY, region.id);
      if (!structure || structure.complete || visited.has(structure.canonicalKey)) continue;
      visited.add(structure.canonicalKey);
      const city = plainCityDescriptor(game, structure, playerId);
      if (city.maxOpponentMeeples > 0 && city.selfMeeples <= city.maxOpponentMeeples) cities.push(city);
    }
  }
  return cities.sort((left, right) => left.key.localeCompare(right.key));
}

function normalizedRandomDecision(items, random) {
  if (!items.length) return { selected: null, randomRoll: null, selectedIndex: -1 };
  if (items.length === 1) return { selected: items[0], randomRoll: null, selectedIndex: 0 };
  const raw = Number(random());
  const randomRoll = Number.isFinite(raw) ? Math.max(0, Math.min(raw, 1 - Number.EPSILON)) : 0;
  const selectedIndex = Math.floor(randomRoll * items.length);
  return { selected: items[selectedIndex], randomRoll, selectedIndex };
}

export function selectTargetCity(cities, random = Math.random) {
  if (!cities.length) return { target: null, ties: [], tied: false, randomRoll: null, tieProcess: "꼽사리 후보 성 없음" };
  const maximum = Math.max(...cities.map((city) => city.future));
  const ties = cities.filter((city) => Math.abs(city.future - maximum) < VALUE_EPSILON);
  const decision = normalizedRandomDecision(ties, random);
  return {
    target: decision.selected,
    ties,
    tied: ties.length > 1,
    randomRoll: decision.randomRoll,
    tieProcess: ties.length > 1
      ? `F_c 최고 동점 ${ties.length}개 · 난수 ${decision.randomRoll.toFixed(4)} · ${decision.selected.key} 선택`
      : `F_c 최고 성 ${decision.selected.key} 한 개`,
  };
}

export function selectBlockingOpponent(game, playerId, random = Math.random) {
  const opponentFutures = game.players
    .filter((player) => player.id !== playerId)
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      future: calculateFutureValue(game, player.id).total,
    }));
  if (!opponentFutures.length) {
    return { opponentFutures, target: null, ties: [], tied: false, randomRoll: null, tieProcess: "방해할 상대 없음" };
  }
  const maximum = Math.max(...opponentFutures.map((item) => item.future));
  const ties = opponentFutures.filter((item) => Math.abs(item.future - maximum) < VALUE_EPSILON);
  const decision = normalizedRandomDecision(ties, random);
  return {
    opponentFutures,
    target: decision.selected,
    ties,
    tied: ties.length > 1,
    randomRoll: decision.randomRoll,
    tieProcess: ties.length > 1
      ? `F_p 최고 동점 ${ties.length}명 · 난수 ${decision.randomRoll.toFixed(4)} · ${decision.selected.playerName} 선택`
      : `F_p 최고 상대 ${decision.selected.playerName} 한 명`,
  };
}

export function findTargetCityInState(game, targetCity) {
  if (!targetCity?.nodes?.length) return null;
  const first = targetCity.nodes[0];
  const structure = traceFeature(game.board, first.x, first.y, FEATURE.CITY, first.regionId);
  if (!structure) return null;
  const nodeKeys = new Set(structure.nodes.map((node) => `${node.x},${node.y}:${node.regionId}`));
  const sameTarget = targetCity.nodes.every((node) => nodeKeys.has(`${node.x},${node.y}:${node.regionId}`));
  return sameTarget ? structure : null;
}

export function matchesJoinPattern(game, action, targetCity, patternMap = JOIN_PATTERN_MAP) {
  const emptyResult = { matched: false, detail: null };
  if (!targetCity || !action.regionId || action.featureType !== FEATURE.CITY) return emptyResult;
  const actionTile = game.currentTile ?? game.lastPlaced?.tile;
  if (!actionTile) return emptyResult;
  const actionShape = cityShapeForTile(actionTile, action.rotation);
  for (const node of targetCity.nodes) {
    const targetTile = game.board.get(node.x, node.y)?.tile;
    if (!targetTile) continue;
    const targetShape = cityShapeForTile(targetTile, targetTile.rotation);
    const dx = action.x - node.x;
    const dy = action.y - node.y;
    const pattern = patternMap.get(`${dx},${dy}:${targetShape}:${actionShape}`);
    if (!pattern) continue;
    return {
      matched: true,
      detail: {
        targetX: node.x,
        targetY: node.y,
        actionX: action.x,
        actionY: action.y,
        dx,
        dy,
        targetShape,
        actionShape,
        patternRotation: pattern.rotation,
      },
    };
  }
  return emptyResult;
}

export function evaluateKimAction(game, action, simulated, context) {
  const metrics = calculateActionMetrics(game, simulated, action, context.playerId);
  const scoreBefore = game.players.find((player) => player.id === context.playerId)?.score ?? 0;
  const scoreGain = metrics.completed - scoreBefore;
  const immediate = scoreGain + metrics.incomplete;
  const meepleValue = context.meeplesAtLeastTurns ? 0 : 3 / (metrics.meeplesAfter + 1);
  const targetFuture = context.targetPlayerId === null
    ? 0
    : calculateFutureValue(simulated, context.targetPlayerId).total;
  const patternResult = matchesJoinPattern(game, action, context.targetCity);
  const simulatedTarget = findTargetCityInState(simulated, context.targetCity);
  const targetCityFutureAfter = simulatedTarget ? calculateCityFutureValue(simulated, simulatedTarget) : null;
  const targetCityFutureMaintained = targetCityFutureAfter !== null
    && Math.abs(targetCityFutureAfter - (context.targetCity?.future ?? 0)) < ZERO_EPSILON;
  const joinEligible = Boolean(context.joinValueCondition
    && action.regionId
    && action.featureType === FEATURE.CITY
    && patternResult.matched
    && targetCityFutureMaintained);
  return {
    action,
    ...metrics,
    cumulativeCompleted: metrics.completed,
    completed: scoreGain,
    scoreGain,
    immediate,
    meepleValue,
    targetFuture,
    patternMatched: patternResult.matched,
    patternDetail: patternResult.detail,
    targetCityFutureAfter,
    targetCityFutureMaintained,
    joinEligible,
    value: immediate + metrics.future + meepleValue,
  };
}

export function filterJoinActions(evaluations, context) {
  if (!context.joinValueCondition) return [];
  return evaluations.filter((evaluation) => evaluation.joinEligible);
}

export function filterBlockingActions(evaluations, context) {
  if (!context.blockingEnabled) return [];
  return evaluations.filter((evaluation) => Math.abs(evaluation.targetFuture) < ZERO_EPSILON);
}

function selectMaximumWithDecision(evaluations, random, reason) {
  if (!evaluations.length) return { evaluation: null, reason: "평가 가능한 합법 행동이 없음", tiedCount: 0, randomRoll: null };
  const maximum = Math.max(...evaluations.map((evaluation) => evaluation.value));
  const ties = evaluations.filter((evaluation) => Math.abs(evaluation.value - maximum) < VALUE_EPSILON);
  const decision = normalizedRandomDecision(ties, random);
  return {
    evaluation: decision.selected,
    reason: ties.length > 1
      ? `${reason} · V_i 최고 동점 ${ties.length}개 · 난수 ${decision.randomRoll.toFixed(4)}로 선택`
      : reason,
    tiedCount: ties.length,
    randomRoll: decision.randomRoll,
  };
}

export const kimGyuminStrategy = Object.freeze({
  id: "kim-gyumin",
  strategyName: "김규민 꼽사리·미래가치 방해 전략",
  valueFormula: "V_i = C_i + N_i + F_i + M_i",
  prepareTurnContext(game, playerId, random) {
    const player = game.players.find((item) => item.id === playerId);
    const context = {
      playerId,
      playerName: player?.name ?? `플레이어 ${playerId + 1}`,
      meeplesBefore: player?.meeples ?? 0,
      remainingOwnTurns: calculateRemainingOwnTurns(game),
    };
    context.meeplesAtLeastTurns = context.meeplesBefore >= context.remainingOwnTurns;
    context.meepleFormula = context.meeplesAtLeastTurns ? "M_i = 0" : "M_i = 3 / (m_i + 1)";

    // A와 c_H는 이 컨텍스트를 만들 때만 각각 한 번 결정합니다.
    const blocking = selectBlockingOpponent(game, playerId, random);
    context.opponentFutures = blocking.opponentFutures;
    context.targetPlayerId = blocking.target?.playerId ?? null;
    context.targetPlayerName = blocking.target?.playerName ?? "없음";
    context.targetTie = blocking.tied;
    context.targetTieCount = blocking.ties.length;
    context.targetRandomRoll = blocking.randomRoll;
    context.targetTieProcess = blocking.tieProcess;
    context.targetFutureBefore = blocking.target?.future ?? 0;
    context.selfFutureBefore = calculateFutureValue(game, playerId).total;
    context.blockingEnabled = context.targetPlayerId !== null
      && context.targetFutureBefore >= context.selfFutureBefore;

    context.joinCities = findJoinableCities(game, playerId);
    const joinTarget = selectTargetCity(context.joinCities, random);
    context.targetCity = joinTarget.target;
    context.targetCityKey = joinTarget.target?.key ?? null;
    context.targetCityTie = joinTarget.tied;
    context.targetCityTieCount = joinTarget.ties.length;
    context.targetCityRandomRoll = joinTarget.randomRoll;
    context.targetCityTieProcess = joinTarget.tieProcess;
    context.targetCityFutureBefore = joinTarget.target?.future ?? 0;
    context.joinValueCondition = Boolean(joinTarget.target
      && context.targetCityFutureBefore - context.selfFutureBefore >= 1);

    context.joinCandidateCount = 0;
    context.blockingCandidateCount = 0;
    context.appliedStage = "평가 중";
    context.finalTieCount = 0;
    context.finalTieRandomRoll = null;
    return context;
  },
  filterActions(actions) {
    return actions;
  },
  evaluateAction(game, action, simulated, context) {
    return evaluateKimAction(game, action, simulated, context);
  },
  selectAction(evaluations, context, random) {
    const joinActions = filterJoinActions(evaluations, context);
    context.joinCandidateCount = joinActions.length;
    let selection;
    if (joinActions.length) {
      context.appliedStage = "꼽사리 전략";
      selection = selectMaximumWithDecision(joinActions, random, `꼽사리 조건을 만족한 ${joinActions.length}개 중 V_i 최대 행동 선택`);
    } else {
      const blockingActions = filterBlockingActions(evaluations, context);
      context.blockingCandidateCount = blockingActions.length;
      if (blockingActions.length) {
        context.appliedStage = "방해 전략";
        selection = selectMaximumWithDecision(blockingActions, random, `고정 상대 ${context.targetPlayerName}의 F_A(S_i)=0인 ${blockingActions.length}개 중 V_i 최대 행동 선택`);
      } else {
        context.appliedStage = "일반 상태 평가";
        selection = selectMaximumWithDecision(evaluations, random, "꼽사리·방해 행동이 없어 전체 합법 행동 중 V_i 최대 행동 선택");
      }
    }
    context.finalTieCount = selection.tiedCount;
    context.finalTieRandomRoll = selection.randomRoll;
    context.finalSelectedAction = selection.evaluation?.action ?? null;
    return selection;
  },
  describeStrategy(context, selectedEvaluation, evaluations, selection) {
    return {
      valueFormula: `${this.valueFormula}, ${context.meepleFormula}`,
      mainConditions: [
        "전략 적용 순서: 꼽사리 전략 → 방해 전략 → 일반 상태 평가",
        `현재 m=${context.meeplesBefore}, Tr=${context.remainingOwnTurns}, m >= Tr: ${context.meeplesAtLeastTurns ? "예" : "아니요"} · ${context.meepleFormula}`,
        `방해 대상 A: ${context.targetPlayerName} · ${context.targetTieProcess}`,
        `F_A(S)=${Number(context.targetFutureBefore ?? 0).toFixed(4)}, F_self(S)=${Number(context.selfFutureBefore ?? 0).toFixed(4)} · 방해 조건: ${context.blockingEnabled ? "충족" : "미충족"}`,
        `꼽사리 후보 성 ${context.joinCities?.length ?? 0}개 · c_H=${context.targetCityKey ?? "없음"} · ${context.targetCityTieProcess}`,
        `F_cH(S)=${Number(context.targetCityFutureBefore ?? 0).toFixed(4)} · F_cH-F_self >= 1: ${context.joinValueCondition ? "충족" : "미충족"}`,
        `적용 단계: ${context.appliedStage} · 꼽사리 후보 ${context.joinCandidateCount}개 · 방해 후보 ${context.blockingCandidateCount}개`,
        `최종 동점: ${context.finalTieCount > 1 ? `${context.finalTieCount}개 · 난수 ${Number(context.finalTieRandomRoll).toFixed(4)}` : "없음"}`,
      ],
      opponentFutures: context.opponentFutures,
      joinCities: context.joinCities,
      targetCityKey: context.targetCityKey,
      appliedStage: context.appliedStage,
      selectionReason: selection.reason,
    };
  },
});
