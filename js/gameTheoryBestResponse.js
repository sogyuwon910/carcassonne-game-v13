import { PHASE } from "./config.js";
import { calculateReturnedMeeples, evaluateState } from "./aiValues.js";
import { getLegalMeepleOptions } from "./featureGraph.js";
import {
  actionKey,
  applyOpponentDraw,
  applySearchAction,
  cloneForBaseline,
  createBaselineCounters,
  createSearchSession,
  createSearchStateKey,
  createTileTypeId,
  disposeSearchSession,
  generateSearchLegalActions,
  getCachedBestResponse,
  getCachedLegalActions,
  getCachedPlaceableTiles,
  getCachedPlayerValue,
  getCachedTransition,
  getSessionStateKey,
  groupRemainingTilesByType,
  noteResultState,
  recordCompactSearchResult,
  setCachedBestResponse,
  undoOpponentDraw,
  undoSearchAction,
  uniqueActions,
} from "./gameTheorySearchSession.js";
import { TileInstance } from "./tile.js";

export {
  actionKey,
  applyOpponentDraw,
  applySearchAction,
  createSearchSession,
  createSearchStateKey,
  createTileTypeId,
  disposeSearchSession,
  generateSearchLegalActions,
  groupRemainingTilesByType,
  recordCompactSearchResult,
  undoOpponentDraw,
  undoSearchAction,
};

const VALUE_EPSILON = 1e-9;
const YIELD_EVERY_STATES = 24;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizedRandomIndex(length, random) {
  if (length <= 1) return 0;
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(value, 1 - Number.EPSILON)) : 0;
  return Math.floor(normalized * length);
}

function chooseRandom(items, random) {
  return items.length ? items[normalizedRandomIndex(items.length, random)] : null;
}

// A는 자신을 제외한 공통 V=I+F 최고 플레이어 중에서 턴 시작 시 한 번만 고릅니다.
export function selectReferenceOpponent(game, selfPlayerId, random = Math.random, searchSession = null) {
  const valueState = searchSession?.rootState ?? game;
  const playerValues = valueState.players.map((player) => {
    const stateValue = searchSession
      ? getCachedPlayerValue(searchSession, valueState, player.id)
      : evaluateState(valueState, player.id);
    return { playerId: player.id, playerName: player.name, ...stateValue };
  });
  const opponents = playerValues.filter((item) => item.playerId !== selfPlayerId);
  if (!opponents.length) {
    return { playerValues, target: null, ties: [], tied: false, tieProcess: "상대 플레이어가 없음" };
  }
  const maximum = Math.max(...opponents.map((item) => item.value));
  const ties = opponents.filter((item) => Math.abs(item.value - maximum) < VALUE_EPSILON);
  const target = chooseRandom(ties, random);
  return {
    playerValues,
    target,
    ties,
    tied: ties.length > 1,
    tieProcess: ties.length > 1
      ? `V 최고 동점 ${ties.length}명 중 주입된 난수로 ${target.playerName} 선택`
      : `V 최고 상대 ${target.playerName} 한 명`,
  };
}

// 사람 조언의 미플 단계도 복사 없이 잠깐 미플만 제거한 뒤 원상복구하여 행동을 생성합니다.
function generateSearchMeepleActions(game, session) {
  if (game.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !game.lastPlaced) return [];
  const started = now();
  session.performanceCounters.legalActionGenerationCalls += 1;
  const preview = game.previewMeeple;
  const originalMeeples = game.lastPlaced.meeples;
  const player = game.currentPlayer;
  const originalPlayerMeeples = player?.meeples ?? 0;
  try {
    if (preview) {
      game.lastPlaced.meeples = originalMeeples.filter((meeple) => meeple !== preview);
      if (player) player.meeples += 1;
      game.previewMeeple = null;
    }
    const { x, y, tile } = game.lastPlaced;
    const actions = [{ x, y, rotation: tile.rotation, regionId: null, featureType: null }];
    for (const region of getLegalMeepleOptions(game.board, x, y, player?.meeples ?? 0)) {
      actions.push({ x, y, rotation: tile.rotation, regionId: region.id, featureType: region.type });
    }
    return uniqueActions(actions);
  } finally {
    game.lastPlaced.meeples = originalMeeples;
    if (player) player.meeples = originalPlayerMeeples;
    game.previewMeeple = preview;
    session.performanceCounters.legalActionGenerationTimeMs += now() - started;
  }
}

// 공개 호환 함수: 배치 불가능한 종류는 제외하고 실제 물리 수량으로 확률을 계산합니다.
export function getPlayableRemainingTiles(game) {
  const playable = groupRemainingTilesByType(game)
    .filter((group) => game.board.getAllLegalPlacements(new TileInstance(group.definition)).length > 0);
  const totalPhysicalTiles = playable.reduce((sum, group) => sum + group.count, 0);
  return playable.map((group) => ({
    ...group,
    probability: totalPhysicalTiles ? group.count / totalPhysicalTiles : 0,
  }));
}

// 기존 외부 API는 독립 복사본을 반환합니다. 최적화 탐색 내부에서는 applyOpponentDraw/undoOpponentDraw를 씁니다.
export function createOpponentDrawState(candidateState, targetPlayerId, tileIdOrTypeId) {
  const responseState = candidateState.cloneForSimulation();
  responseState.listeners.clear();
  const targetIndex = responseState.players.findIndex((player) => player.id === targetPlayerId);
  const deckIndex = responseState.deck.findIndex((tile) => tile.definition.id === tileIdOrTypeId
    || createTileTypeId(tile.definition) === tileIdOrTypeId);
  if (targetIndex < 0 || deckIndex < 0) return null;
  const [drawnTile] = responseState.deck.splice(deckIndex, 1);
  drawnTile.rotation = 0;
  responseState.currentPlayerIndex = targetIndex;
  responseState.currentTile = drawnTile;
  responseState.lastPlaced = null;
  responseState.lastPlacement = null;
  responseState.previewMeeple = null;
  responseState.lastScoreResults = [];
  responseState.phase = PHASE.ROTATE_OR_PLACE;
  return responseState;
}

function selectMaximum(evaluations, random) {
  if (!evaluations.length) return { evaluation: null, reason: "평가 가능한 합법 행동이 없음", tiedCount: 0 };
  const maximum = Math.max(...evaluations.map((item) => item.value));
  const ties = evaluations.filter((item) => Math.abs(item.value - maximum) < VALUE_EPSILON);
  return {
    evaluation: chooseRandom(ties, random),
    reason: ties.length > 1
      ? `G(x_i) 최대값 동점 ${ties.length}개 중 주입된 난수로 선택`
      : "G(x_i) = V_self(S_i) - R_A(S_i)가 최대인 행동 선택",
    tiedCount: ties.length,
  };
}

function emptyProgress(totalCandidates) {
  return {
    phase: "자신의 후보 준비",
    completedCandidates: 0,
    totalCandidates,
    percent: totalCandidates ? 0 : 100,
    physicalTileCount: 0,
    uniqueTileTypeCount: 0,
    simulationStateCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    duplicateStateCount: 0,
    calculationTimeMs: 0,
  };
}

async function yieldToBrowser() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function syncProgress(progress, session, startTime) {
  const counters = session.performanceCounters;
  progress.physicalTileCount = counters.physicalTileCount;
  progress.uniqueTileTypeCount = counters.uniqueTileTypeCount;
  progress.simulationStateCount = counters.simulationStateCount;
  progress.cacheHits = counters.cacheHits;
  progress.cacheMisses = counters.cacheMisses;
  progress.duplicateStateCount = counters.duplicateStateCount;
  progress.calculationTimeMs = now() - startTime;
  counters.totalSearchTimeMs = progress.calculationTimeMs;
}

function copyPerformanceSummary(context, session) {
  const counters = session.performanceCounters;
  context.performanceCounters = counters;
  context.simulationStateCount = counters.simulationStateCount;
  context.calculationTimeMs = counters.totalSearchTimeMs;
  context.cacheHits = counters.cacheHits;
  context.cacheMisses = counters.cacheMisses;
  context.duplicateStateCount = counters.duplicateStateCount;
}

// 모든 x, 배치 가능한 모든 타일 종류 t, 모든 상대 행동 y를 그대로 검사합니다.
// 각 분기는 같은 루트 복사본에 적용하고 finally에서 역순으로 복원합니다.
export async function evaluateGameTheoryTurn(game, actions, context, {
  mode = "placement",
  random = Math.random,
  shouldCancel = () => false,
  onProgress = null,
  yieldEvery = YIELD_EVERY_STATES,
  yieldBetweenCandidates = true,
  searchSession = null,
  verifyRestoration = false,
} = {}) {
  const ownsSession = !searchSession;
  const session = searchSession ?? createSearchSession(game, {
    selectedOpponentA: context.targetPlayerId,
    verifyRestoration,
  });
  session.selectedOpponentA = context.targetPlayerId;
  const searchState = session.rootState;
  const startTime = now();
  const evaluations = [];
  const progress = emptyProgress(actions.length);
  const safeYieldEvery = Math.max(1, Number(yieldEvery) || YIELD_EVERY_STATES);
  context.progress = progress;
  session.performanceCounters.selfCandidateCount = actions.length;

  const reportProgress = async (phase, force = false) => {
    progress.phase = phase;
    progress.percent = progress.totalCandidates
      ? Math.round((progress.completedCandidates / progress.totalCandidates) * 100)
      : 100;
    syncProgress(progress, session, startTime);
    copyPerformanceSummary(context, session);
    if (typeof onProgress === "function") onProgress({
      completedEvaluationCount: evaluations.length,
      progress: { ...progress },
    });
    if (force || (progress.simulationStateCount > 0
      && progress.simulationStateCount % safeYieldEvery === 0)) await yieldToBrowser();
    return !shouldCancel();
  };

  try {
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      if (shouldCancel()) break;
      const action = actions[actionIndex];
      const candidatePatch = applySearchAction(session, searchState, action, { mode });
      if (!candidatePatch) continue;
      let completedCandidate = false;
      try {
        const candidateKey = getSessionStateKey(session, searchState);
        noteResultState(session, candidateKey);
        const selfStateValue = getCachedPlayerValue(session, searchState, context.playerId);
        const beforeMeeples = game.players.find((player) => player.id === context.playerId)?.meeples ?? 0;
        const meeplesAfter = searchState.players.find((player) => player.id === context.playerId)?.meeples ?? 0;
        const metrics = {
          ...selfStateValue,
          meeplesAfter,
          returnedMeeples: calculateReturnedMeeples(beforeMeeples, searchState, context.playerId, action),
        };
        const selfValue = selfStateValue.value;
        const playableTiles = getCachedPlaceableTiles(session, searchState, context.targetPlayerId);
        session.performanceCounters.physicalTileCount += playableTiles.reduce((sum, group) => sum + group.count, 0);
        session.performanceCounters.uniqueTileTypeCount += playableTiles.length;
        const tileResponses = [];
        let expectedResponse = 0;

        if (!playableTiles.length || context.targetPlayerId === null) {
          expectedResponse = context.targetPlayerId === null
            ? 0
            : getCachedPlayerValue(session, searchState, context.targetPlayerId).value;
        } else {
          for (const tileGroup of playableTiles) {
            if (shouldCancel()) break;
            const bestResponseKey = `${candidateKey}#A:${context.targetPlayerId}#T:${tileGroup.tileTypeId}`;
            let bestResponse = getCachedBestResponse(session, bestResponseKey);
            if (!bestResponse) {
              const drawPatch = applyOpponentDraw(
                session,
                searchState,
                context.targetPlayerId,
                tileGroup.tileTypeId,
              );
              if (!drawPatch) continue;
              try {
                const responseBaseKey = getSessionStateKey(session, searchState);
                const responseActions = getCachedLegalActions(
                  session,
                  searchState,
                  context.targetPlayerId,
                  tileGroup.tileTypeId,
                );
                session.performanceCounters.responseActionCount += responseActions.length;
                let bestValue = -Infinity;
                let bestActions = [];
                const uniqueResponseStates = new Set();

                for (const responseAction of responseActions) {
                  if (shouldCancel()) break;
                  const transitionKey = `${responseBaseKey}#Y:${actionKey(responseAction)}`;
                  const responseResult = getCachedTransition(session, transitionKey, () => {
                    const responsePatch = applySearchAction(session, searchState, responseAction);
                    if (!responsePatch) return null;
                    try {
                      const resultKey = getSessionStateKey(session, searchState);
                      noteResultState(session, resultKey);
                      return Object.freeze({
                        stateKey: resultKey,
                        value: getCachedPlayerValue(session, searchState, context.targetPlayerId).value,
                      });
                    } finally {
                      undoSearchAction(session, searchState, responsePatch);
                    }
                  });
                  if (!responseResult) continue;
                  uniqueResponseStates.add(responseResult.stateKey);
                  if (responseResult.value > bestValue + VALUE_EPSILON) {
                    bestValue = responseResult.value;
                    bestActions = [responseAction];
                  } else if (Math.abs(responseResult.value - bestValue) < VALUE_EPSILON) {
                    bestActions.push(responseAction);
                  }
                  if (session.performanceCounters.simulationStateCount % safeYieldEvery === 0) {
                    const keepGoing = await reportProgress(
                      `후보 ${actionIndex + 1}/${actions.length} · TILE ${String(tileGroup.tileId).padStart(2, "0")} 대응 계산`,
                    );
                    if (!keepGoing) break;
                  }
                }
                if (shouldCancel()) break;
                if (!Number.isFinite(bestValue)) {
                  bestValue = getCachedPlayerValue(session, searchState, context.targetPlayerId).value;
                }
                bestResponse = setCachedBestResponse(session, bestResponseKey, {
                  responseActionCount: responseActions.length,
                  uniqueResponseStateCount: uniqueResponseStates.size,
                  bestAction: bestActions[0] ?? null,
                  bestValue,
                  tiedBestCount: bestActions.length,
                });
              } finally {
                undoOpponentDraw(session, searchState, drawPatch);
              }
            }
            if (shouldCancel()) break;
            expectedResponse += tileGroup.probability * bestResponse.bestValue;
            tileResponses.push({
              tileTypeId: tileGroup.tileTypeId,
              tileId: tileGroup.tileId,
              count: tileGroup.count,
              probability: tileGroup.probability,
              responseActionCount: bestResponse.responseActionCount,
              uniqueResponseStateCount: bestResponse.uniqueResponseStateCount,
              bestAction: bestResponse.bestAction,
              bestValue: bestResponse.bestValue,
              tiedBestCount: bestResponse.tiedBestCount,
            });
          }
        }
        if (shouldCancel()) break;

        const evaluation = {
          action,
          ...metrics,
          selfValue,
          playableTileCount: playableTiles.reduce((sum, tile) => sum + tile.count, 0),
          uniquePlayableTileTypeCount: playableTiles.length,
          tileResponses,
          expectedResponse,
          value: selfValue - expectedResponse,
        };
        evaluations.push(evaluation);
        recordCompactSearchResult(session, evaluation);
        completedCandidate = true;
      } finally {
        undoSearchAction(session, searchState, candidatePatch);
      }
      if (!completedCandidate) break;
      progress.completedCandidates = actionIndex + 1;
      await reportProgress(
        `자신의 후보 ${actionIndex + 1}/${actions.length} 완료`,
        yieldBetweenCandidates,
      );
    }

    syncProgress(progress, session, startTime);
    copyPerformanceSummary(context, session);
    if (shouldCancel()) {
      return {
        evaluations,
        selection: { evaluation: null, reason: "게임 상태가 변경되어 탐색을 취소함", tiedCount: 0 },
        cancelled: true,
      };
    }
    progress.phase = "계산 완료";
    progress.percent = 100;
    const selection = selectMaximum(evaluations, random);
    context.finalTieCount = selection.tiedCount;
    context.progress = { ...progress };
    return { evaluations, selection, cancelled: false };
  } finally {
    syncProgress(progress, session, startTime);
    copyPerformanceSummary(context, session);
    if (ownsSession) disposeSearchSession(session);
  }
}

// 아래 기준 구현은 최적화 전의 전체 복사 탐색을 테스트/벤치마크에서만 재현합니다.
function simulateActionBaseline(game, action, counters) {
  const clone = cloneForBaseline(game, counters);
  if (!clone.currentTile) return null;
  clone.currentTile.rotation = action.rotation;
  if (!clone.placeCurrentTile(action.x, action.y)) return null;
  if (action.regionId) clone.toggleMeeple(action.regionId);
  clone.finishTurn();
  counters.simulationStateCount += 1;
  return clone;
}

function simulateMeepleActionBaseline(game, action, counters) {
  const clone = cloneForBaseline(game, counters);
  if (clone.previewMeeple) clone.cancelMeeple({ notify: false });
  if (action.regionId && !clone.toggleMeeple(action.regionId)) return null;
  clone.finishTurn();
  counters.simulationStateCount += 1;
  return clone;
}

export function generateSearchLegalActionsBaseline(game, counters = createBaselineCounters()) {
  if (!game.currentTile) return [];
  const started = now();
  counters.legalActionGenerationCalls += 1;
  const actions = [];
  for (const placement of game.board.getAllLegalPlacements(game.currentTile)) {
    const temporary = cloneForBaseline(game, counters);
    temporary.currentTile.rotation = placement.rotation;
    if (!temporary.placeCurrentTile(placement.x, placement.y)) continue;
    actions.push({ ...placement, regionId: null, featureType: null });
    for (const region of temporary.getMeepleOptions()) {
      actions.push({ ...placement, regionId: region.id, featureType: region.type });
    }
  }
  counters.legalActionGenerationTimeMs += now() - started;
  return uniqueActions(actions);
}

function createOpponentDrawStateBaseline(candidateState, targetPlayerId, tileTypeId, counters) {
  const responseState = cloneForBaseline(candidateState, counters);
  const targetIndex = responseState.players.findIndex((player) => player.id === targetPlayerId);
  const deckIndex = responseState.deck.findIndex((tile) => createTileTypeId(tile.definition) === tileTypeId);
  if (targetIndex < 0 || deckIndex < 0) return null;
  const [drawnTile] = responseState.deck.splice(deckIndex, 1);
  drawnTile.rotation = 0;
  responseState.currentPlayerIndex = targetIndex;
  responseState.currentTile = drawnTile;
  responseState.lastPlaced = null;
  responseState.lastPlacement = null;
  responseState.previewMeeple = null;
  responseState.lastScoreResults = [];
  responseState.phase = PHASE.ROTATE_OR_PLACE;
  return responseState;
}

function baselineStateKey(state, counters) {
  const started = now();
  const key = createSearchStateKey(state);
  counters.stateKeyRequestCount += 1;
  counters.stateKeyBuildCount += 1;
  counters.stateKeyBuildTimeMs += now() - started;
  return key;
}

function baselineStateValue(state, playerId, valueCache, counters) {
  counters.stateValueRequestCount += 1;
  const key = `${baselineStateKey(state, counters)}#V:${playerId}`;
  if (valueCache.has(key)) {
    counters.cacheHits += 1;
    counters.cacheStats.stateValue.hits += 1;
    return valueCache.get(key);
  }
  counters.cacheMisses += 1;
  counters.cacheStats.stateValue.misses += 1;
  const started = now();
  const value = evaluateState(state, playerId);
  const elapsed = now() - started;
  counters.stateValueCalculationCount += 1;
  counters.futureValueRequestCount += 1;
  counters.futureValueCalculationCount += 1;
  counters.stateValueCalculationTimeMs += elapsed;
  counters.futureValueCalculationTimeMs += elapsed;
  valueCache.set(key, value);
  return value;
}

export async function evaluateGameTheoryTurnBaseline(game, actions, context, {
  mode = "placement",
  random = Math.random,
  shouldCancel = () => false,
  onProgress = null,
  yieldEvery = YIELD_EVERY_STATES,
  yieldBetweenCandidates = true,
} = {}) {
  const startTime = now();
  const evaluations = [];
  const counters = createBaselineCounters();
  const valueCache = new Map();
  const responseActionCache = new Map();
  const outcomeCache = new Map();
  const seenResultStates = new Set();
  const progress = emptyProgress(actions.length);
  const safeYieldEvery = Math.max(1, Number(yieldEvery) || YIELD_EVERY_STATES);
  context.progress = progress;
  counters.selfCandidateCount = actions.length;

  const reportProgress = async (phase, force = false) => {
    progress.phase = phase;
    progress.percent = progress.totalCandidates
      ? Math.round((progress.completedCandidates / progress.totalCandidates) * 100)
      : 100;
    progress.simulationStateCount = counters.simulationStateCount;
    progress.cacheHits = counters.cacheHits;
    progress.duplicateStateCount = counters.duplicateStateCount;
    progress.calculationTimeMs = now() - startTime;
    if (typeof onProgress === "function") onProgress({ completedEvaluationCount: evaluations.length, progress: { ...progress } });
    if (force || (counters.simulationStateCount > 0
      && counters.simulationStateCount % safeYieldEvery === 0)) await yieldToBrowser();
    return !shouldCancel();
  };

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    if (shouldCancel()) break;
    const action = actions[actionIndex];
    const candidateState = mode === "meeple"
      ? simulateMeepleActionBaseline(game, action, counters)
      : simulateActionBaseline(game, action, counters);
    if (!candidateState) continue;
    const candidateKey = baselineStateKey(candidateState, counters);
    if (seenResultStates.has(candidateKey)) counters.duplicateStateCount += 1;
    else seenResultStates.add(candidateKey);
    const selfStateValue = baselineStateValue(candidateState, context.playerId, valueCache, counters);
    const beforeMeeples = game.players.find((player) => player.id === context.playerId)?.meeples ?? 0;
    const meeplesAfter = candidateState.players.find((player) => player.id === context.playerId)?.meeples ?? 0;
    const metrics = {
      ...selfStateValue,
      meeplesAfter,
      returnedMeeples: calculateReturnedMeeples(beforeMeeples, candidateState, context.playerId, action),
    };
    const playableTiles = getPlayableRemainingTiles(candidateState);
    counters.physicalTileCount += playableTiles.reduce((sum, group) => sum + group.count, 0);
    counters.uniqueTileTypeCount += playableTiles.length;
    const tileResponses = [];
    let expectedResponse = 0;

    if (!playableTiles.length || context.targetPlayerId === null) {
      expectedResponse = context.targetPlayerId === null
        ? 0
        : baselineStateValue(candidateState, context.targetPlayerId, valueCache, counters).value;
    } else {
      for (const tileGroup of playableTiles) {
        if (shouldCancel()) break;
        const responseBase = createOpponentDrawStateBaseline(
          candidateState,
          context.targetPlayerId,
          tileGroup.tileTypeId,
          counters,
        );
        if (!responseBase) continue;
        const responseKey = `${candidateKey}#A:${context.targetPlayerId}#T:${tileGroup.tileTypeId}`;
        let responseActions = responseActionCache.get(responseKey);
        if (responseActions) {
          counters.cacheHits += 1;
          counters.cacheStats.legalActions.hits += 1;
        } else {
          counters.cacheMisses += 1;
          counters.cacheStats.legalActions.misses += 1;
          responseActions = generateSearchLegalActionsBaseline(responseBase, counters);
          responseActionCache.set(responseKey, responseActions);
        }
        counters.responseActionCount += responseActions.length;
        let bestValue = -Infinity;
        let bestActions = [];
        const uniqueResponseStates = new Set();
        for (const responseAction of responseActions) {
          if (shouldCancel()) break;
          const outcomeKey = `${responseKey}#Y:${actionKey(responseAction)}`;
          let responseResult = outcomeCache.get(outcomeKey);
          if (responseResult) {
            counters.cacheHits += 1;
            counters.cacheStats.transition.hits += 1;
          } else {
            counters.cacheMisses += 1;
            counters.cacheStats.transition.misses += 1;
            const responseState = simulateActionBaseline(responseBase, responseAction, counters);
            if (!responseState) continue;
            const resultKey = baselineStateKey(responseState, counters);
            if (seenResultStates.has(resultKey)) counters.duplicateStateCount += 1;
            else seenResultStates.add(resultKey);
            responseResult = { stateKey: resultKey, value: baselineStateValue(responseState, context.targetPlayerId, valueCache, counters).value };
            outcomeCache.set(outcomeKey, responseResult);
          }
          uniqueResponseStates.add(responseResult.stateKey);
          if (responseResult.value > bestValue + VALUE_EPSILON) {
            bestValue = responseResult.value;
            bestActions = [responseAction];
          } else if (Math.abs(responseResult.value - bestValue) < VALUE_EPSILON) {
            bestActions.push(responseAction);
          }
          if (counters.simulationStateCount % safeYieldEvery === 0) {
            const keepGoing = await reportProgress(
              `후보 ${actionIndex + 1}/${actions.length} · TILE ${String(tileGroup.tileId).padStart(2, "0")} 대응 계산`,
            );
            if (!keepGoing) break;
          }
        }
        if (shouldCancel()) break;
        if (!Number.isFinite(bestValue)) bestValue = baselineStateValue(responseBase, context.targetPlayerId, valueCache, counters).value;
        const bestAction = bestActions[0] ?? null;
        expectedResponse += tileGroup.probability * bestValue;
        tileResponses.push({
          tileTypeId: tileGroup.tileTypeId,
          tileId: tileGroup.tileId,
          count: tileGroup.count,
          probability: tileGroup.probability,
          responseActionCount: responseActions.length,
          uniqueResponseStateCount: uniqueResponseStates.size,
          bestAction,
          bestValue,
          tiedBestCount: bestActions.length,
        });
      }
    }
    if (shouldCancel()) break;
    evaluations.push({
      action,
      ...metrics,
      selfValue: selfStateValue.value,
      playableTileCount: playableTiles.reduce((sum, tile) => sum + tile.count, 0),
      uniquePlayableTileTypeCount: playableTiles.length,
      tileResponses,
      expectedResponse,
      value: selfStateValue.value - expectedResponse,
    });
    progress.completedCandidates = actionIndex + 1;
    await reportProgress(
      `자신의 후보 ${actionIndex + 1}/${actions.length} 완료`,
      yieldBetweenCandidates,
    );
  }

  counters.totalSearchTimeMs = now() - startTime;
  context.performanceCounters = counters;
  context.simulationStateCount = counters.simulationStateCount;
  context.calculationTimeMs = counters.totalSearchTimeMs;
  context.cacheHits = counters.cacheHits;
  context.cacheMisses = counters.cacheMisses;
  context.duplicateStateCount = counters.duplicateStateCount;
  if (shouldCancel()) {
    return {
      evaluations,
      selection: { evaluation: null, reason: "게임 상태가 변경되어 탐색을 취소함", tiedCount: 0 },
      cancelled: true,
    };
  }
  progress.phase = "계산 완료";
  progress.percent = 100;
  progress.calculationTimeMs = counters.totalSearchTimeMs;
  const selection = selectMaximum(evaluations, random);
  context.finalTieCount = selection.tiedCount;
  context.progress = { ...progress };
  return { evaluations, selection, cancelled: false };
}

export const gameTheoryBestResponseStrategy = Object.freeze({
  id: "gameTheoryBestResponse",
  strategyName: "최고 가치 상대 최선 대응 전략",
  valueFormula: "G(x_i) = V_self(S_i) - R_A(S_i)",
  createSearchSession(game) {
    return createSearchSession(game);
  },
  generateActions(game, mode, searchSession) {
    const state = searchSession?.rootState ?? game;
    if (mode === "meeple") return generateSearchMeepleActions(state, searchSession);
    return generateSearchLegalActions(state, searchSession);
  },
  prepareTurnContext(game, playerId, random, searchSession = null) {
    const result = selectReferenceOpponent(game, playerId, random, searchSession);
    const self = result.playerValues.find((item) => item.playerId === playerId);
    if (searchSession) searchSession.selectedOpponentA = result.target?.playerId ?? null;
    return {
      playerId,
      playerName: self?.playerName ?? `플레이어 ${playerId + 1}`,
      selfValueBefore: self?.value ?? 0,
      playerValues: result.playerValues,
      targetPlayerId: result.target?.playerId ?? null,
      targetPlayerName: result.target?.playerName ?? "없음",
      targetTie: result.tied,
      targetTieCount: result.ties.length,
      targetTieProcess: result.tieProcess,
      progress: emptyProgress(0),
      performanceCounters: searchSession?.performanceCounters ?? null,
    };
  },
  filterActions(actions) {
    return uniqueActions(actions);
  },
  evaluateTurn: evaluateGameTheoryTurn,
  disposeSearchSession,
  describeStrategy(context, selectedEvaluation, evaluations, selection) {
    const counters = context.performanceCounters ?? {};
    return {
      valueFormula: this.valueFormula,
      mainConditions: [
        `현재 V_self(S)=${Number(context.selfValueBefore ?? 0).toFixed(4)}`,
        `기준 상대 A: ${context.targetPlayerName}`,
        context.targetTieProcess,
        "덱 순서 대신 배치 가능한 남은 타일의 물리 수량으로 기대값 계산",
        `후보 ${context.progress?.totalCandidates ?? 0}개 · 검사한 물리 타일 ${counters.physicalTileCount ?? 0}장 · 고유 종류 ${counters.uniqueTileTypeCount ?? 0}개`,
        `시뮬레이션 상태 ${counters.simulationStateCount ?? 0}개 · 전체 복사 ${counters.fullStateCloneCount ?? 0}회 · 캐시 적중 ${counters.cacheHits ?? 0}회`,
        `V 계산 ${counters.stateValueCalculationCount ?? 0}회 · F 계산 ${counters.futureValueCalculationCount ?? 0}회 · 상태 키 생성 ${counters.stateKeyBuildCount ?? 0}회`,
        `계산 시간 ${Number(context.calculationTimeMs ?? context.progress?.calculationTimeMs ?? 0).toFixed(1)}ms`,
      ],
      playerValues: context.playerValues,
      selectionReason: selection.reason,
    };
  },
});
