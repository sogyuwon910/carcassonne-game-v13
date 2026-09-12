import { PHASE } from "./config.js";
import {
  calculateCompletedScoreValue,
  calculateFutureValue,
  calculateIncompleteScoreValue,
} from "./aiValues.js";
import { getLegalMeepleOptions } from "./featureGraph.js";
import { TileInstance } from "./tile.js";

const TILE_TYPE_ID_CACHE = new WeakMap();

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function actionKey(action) {
  return `${action.x},${action.y}:${action.rotation}:${action.regionId ?? "-"}`;
}

export function uniqueActions(actions) {
  return [...new Map(actions.map((action) => [actionKey(action), action])).values()];
}

function sortedMeeples(meeples) {
  return meeples
    .map((meeple) => [
      meeple.playerId,
      meeple.type,
      meeple.regionId,
      Number(meeple.x ?? 0),
      Number(meeple.y ?? 0),
    ].join(":"))
    .sort()
    .join(",");
}

// ID뿐 아니라 배치·연결·점수 규칙에 영향을 주는 정의를 모두 포함합니다.
// 따라서 그림이나 이름만 같은 타일은 묶지 않고 실제 규칙이 같은 물리 타일만 묶습니다.
export function createTileTypeId(definition) {
  if (TILE_TYPE_ID_CACHE.has(definition)) return TILE_TYPE_ID_CACHE.get(definition);
  const groups = (items) => items
    .map((group) => [...group].map(Number).sort((left, right) => left - right).join("."))
    .sort()
    .join(";");
  const terminals = Object.entries(definition.roadTerminal ?? {})
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(",");
  const typeId = [
    definition.id,
    [1, 2, 3, 4].map((direction) => definition.edges[direction]).join(""),
    groups(definition.cityGroups ?? []),
    groups(definition.roadGroups ?? []),
    definition.monastery ? 1 : 0,
    definition.shield ? 1 : 0,
    definition.village ? 1 : 0,
    terminals,
  ].join("/");
  TILE_TYPE_ID_CACHE.set(definition, typeId);
  return typeId;
}

function deckCountKey(deck) {
  const counts = new Map();
  for (const tile of deck) {
    const typeId = createTileTypeId(tile.definition);
    counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([typeId, count]) => `${typeId}x${count}`)
    .join(",");
}

// 캐시 정확성에 필요한 보드, 미플, 점수, 덱 수량, 턴, 단계와 임시 타일을 빠짐없이 넣습니다.
// UI 문자열과 실제 덱 순서는 가치 계산에 영향을 주지 않으므로 의도적으로 제외합니다.
export function createSearchStateKey(game) {
  const board = game.board.values()
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((placed) => `${placed.x},${placed.y}:${createTileTypeId(placed.tile.definition)}:${placed.tile.rotation}:${sortedMeeples(placed.meeples)}`)
    .join("|");
  const players = game.players.map((player) => `${player.id}:${player.score}:${player.meeples}`).join("|");
  const scored = [...(game.scoredFeatureKeys ?? [])].sort().join(",");
  const currentTile = game.currentTile
    ? `${createTileTypeId(game.currentTile.definition)}:${game.currentTile.rotation}`
    : "-";
  const lastPlaced = game.lastPlaced ? `${game.lastPlaced.x},${game.lastPlaced.y}` : "-";
  const lastPlacement = game.lastPlacement
    ? `${game.lastPlacement.x},${game.lastPlacement.y}:${game.lastPlacement.playerId}`
    : "-";
  const preview = game.previewMeeple
    ? `${game.previewMeeple.playerId}:${game.previewMeeple.type}:${game.previewMeeple.regionId}`
    : "-";
  return `${board}#${players}#${deckCountKey(game.deck)}#${scored}#${game.currentPlayerIndex}#${game.phase}#${currentTile}#${lastPlaced}#${lastPlacement}#${preview}`;
}

function createCacheStats() {
  return {
    legalActions: { hits: 0, misses: 0 },
    stateValue: { hits: 0, misses: 0 },
    futureValue: { hits: 0, misses: 0 },
    transition: { hits: 0, misses: 0 },
    bestResponse: { hits: 0, misses: 0 },
    placeableTiles: { hits: 0, misses: 0 },
  };
}

function createPerformanceCounters() {
  return {
    totalSearchTimeMs: 0,
    selfCandidateCount: 0,
    physicalTileCount: 0,
    uniqueTileTypeCount: 0,
    responseActionCount: 0,
    simulationStateCount: 0,
    duplicateStateCount: 0,
    fullStateCloneCount: 0,
    fullStateCloneTimeMs: 0,
    legalActionGenerationCalls: 0,
    legalActionGenerationTimeMs: 0,
    stateValueRequestCount: 0,
    stateValueCalculationCount: 0,
    stateValueCalculationTimeMs: 0,
    futureValueRequestCount: 0,
    futureValueCalculationCount: 0,
    futureValueCalculationTimeMs: 0,
    stateKeyRequestCount: 0,
    stateKeyBuildCount: 0,
    stateKeyBuildTimeMs: 0,
    stateKeyVersionHitCount: 0,
    actionApplyCount: 0,
    actionUndoCount: 0,
    drawApplyCount: 0,
    drawUndoCount: 0,
    maximumPatchDepth: 0,
    compactLogRecordCount: 0,
    compactLogBuildTimeMs: 0,
    progressLogBuildTimeMs: 0,
    finalLogBuildTimeMs: 0,
    detailedLogBuildCount: 0,
    detailedLogBuildTimeMs: 0,
    aiLogRenderCount: 0,
    aiLogRenderTimeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheStats: createCacheStats(),
  };
}

function cloneGame(game, counters, { includeAiDebug = false } = {}) {
  const started = now();
  const clone = game.cloneForSimulation({ includeAiDebug });
  clone.listeners.clear();
  counters.fullStateCloneCount += 1;
  counters.fullStateCloneTimeMs += now() - started;
  return clone;
}

export function createSearchSession(game, { selectedOpponentA = null, verifyRestoration = false } = {}) {
  const performanceCounters = createPerformanceCounters();
  const rootState = cloneGame(game, performanceCounters);
  const started = now();
  const rootStateId = createSearchStateKey(rootState);
  performanceCounters.stateKeyRequestCount += 1;
  performanceCounters.stateKeyBuildCount += 1;
  performanceCounters.stateKeyBuildTimeMs += now() - started;
  return {
    rootStateId,
    rootState,
    selectedOpponentA,
    legalActionsCache: new Map(),
    stateValueCache: new Map(),
    futureValueCache: new Map(),
    transitionCache: new Map(),
    bestResponseCache: new Map(),
    placeableTileCache: new Map(),
    stateKeyByVersion: new Map([[0, rootStateId]]),
    currentStateVersion: 0,
    nextStateVersion: 1,
    patchStack: [],
    performanceCounters,
    compactLogData: [],
    seenResultStates: new Set(),
    verifyRestoration,
    disposed: false,
  };
}

export function getSessionStateKey(session, game = session.rootState) {
  const counters = session.performanceCounters;
  counters.stateKeyRequestCount += 1;
  if (session.stateKeyByVersion.has(session.currentStateVersion)) {
    counters.stateKeyVersionHitCount += 1;
    return session.stateKeyByVersion.get(session.currentStateVersion);
  }
  const started = now();
  const key = createSearchStateKey(game);
  counters.stateKeyBuildCount += 1;
  counters.stateKeyBuildTimeMs += now() - started;
  session.stateKeyByVersion.set(session.currentStateVersion, key);
  return key;
}

function cacheLookup(session, cacheName, cache, key, calculate) {
  const stats = session.performanceCounters.cacheStats[cacheName];
  if (cache.has(key)) {
    stats.hits += 1;
    session.performanceCounters.cacheHits += 1;
    return cache.get(key);
  }
  stats.misses += 1;
  session.performanceCounters.cacheMisses += 1;
  const value = calculate();
  cache.set(key, value);
  return value;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

// 보드에 임시 타일 하나만 꽂았다 빼서 미플 선택지를 얻습니다. 점수·덱·턴은 건드리지 않습니다.
export function generateSearchLegalActions(game, session = null) {
  if (!game.currentTile) return [];
  const counters = session?.performanceCounters;
  const started = now();
  if (counters) counters.legalActionGenerationCalls += 1;
  const actions = [];
  try {
    for (const placement of game.board.getAllLegalPlacements(game.currentTile)) {
      const tile = new TileInstance(game.currentTile.definition, placement.rotation);
      const placed = game.board.place(tile, placement.x, placement.y);
      try {
        actions.push({ ...placement, regionId: null, featureType: null });
        for (const region of getLegalMeepleOptions(
          game.board,
          placement.x,
          placement.y,
          game.currentPlayer?.meeples ?? 0,
        )) {
          actions.push({ ...placement, regionId: region.id, featureType: region.type });
        }
      } finally {
        // 임시 배치는 항상 제거되어 실제/탐색 상태에 흔적을 남기지 않습니다.
        if (game.board.get(placement.x, placement.y) === placed) game.board.remove(placement.x, placement.y);
      }
    }
    return uniqueActions(actions);
  } finally {
    if (counters) counters.legalActionGenerationTimeMs += now() - started;
  }
}

export function getCachedLegalActions(session, game, actingPlayerId, tileTypeId) {
  const stateKey = getSessionStateKey(session, game);
  const key = `${stateKey}#LEGAL:${actingPlayerId}:${tileTypeId}`;
  return cacheLookup(session, "legalActions", session.legalActionsCache, key, () => Object.freeze(
    generateSearchLegalActions(game, session).map((action) => Object.freeze({ ...action })),
  ));
}

export function getCachedFutureValue(session, game, playerId) {
  session.performanceCounters.futureValueRequestCount += 1;
  const stateKey = getSessionStateKey(session, game);
  const key = `${stateKey}#F:${playerId}`;
  return cacheLookup(session, "futureValue", session.futureValueCache, key, () => {
    const started = now();
    const result = calculateFutureValue(game, playerId);
    session.performanceCounters.futureValueCalculationCount += 1;
    session.performanceCounters.futureValueCalculationTimeMs += now() - started;
    return deepFreeze({ ...result });
  });
}

export function getCachedPlayerValue(session, game, playerId) {
  session.performanceCounters.stateValueRequestCount += 1;
  const stateKey = getSessionStateKey(session, game);
  const key = `${stateKey}#V:${playerId}`;
  return cacheLookup(session, "stateValue", session.stateValueCache, key, () => {
    const started = now();
    const completed = calculateCompletedScoreValue(game, playerId);
    const incomplete = calculateIncompleteScoreValue(game, playerId);
    const immediate = completed + incomplete;
    const futureResult = getCachedFutureValue(session, game, playerId);
    const result = Object.freeze({
      completed,
      incomplete,
      immediate,
      future: futureResult.total,
      featureDetails: futureResult.details,
      value: immediate + futureResult.total,
    });
    session.performanceCounters.stateValueCalculationCount += 1;
    session.performanceCounters.stateValueCalculationTimeMs += now() - started;
    return result;
  });
}

export function groupRemainingTilesByType(game) {
  const groups = new Map();
  for (const tile of game.deck) {
    const tileTypeId = createTileTypeId(tile.definition);
    const group = groups.get(tileTypeId) ?? {
      tileTypeId,
      tileId: tile.definition.id,
      definition: tile.definition,
      count: 0,
    };
    group.count += 1;
    groups.set(tileTypeId, group);
  }
  return [...groups.values()].sort((left, right) => left.tileId - right.tileId
    || left.tileTypeId.localeCompare(right.tileTypeId));
}

// 같은 규칙 종류는 한 번만 배치 가능성을 검사하고, 확률에는 실제 물리 수량을 유지합니다.
export function getCachedPlaceableTiles(session, game, targetPlayerId) {
  const stateKey = getSessionStateKey(session, game);
  const key = `${stateKey}#PLACEABLE:${targetPlayerId}`;
  return cacheLookup(session, "placeableTiles", session.placeableTileCache, key, () => {
    const playable = groupRemainingTilesByType(game)
      .filter((group) => game.board.getAllLegalPlacements(new TileInstance(group.definition)).length > 0);
    const totalPhysicalTiles = playable.reduce((sum, group) => sum + group.count, 0);
    return Object.freeze(playable.map((group) => Object.freeze({
      ...group,
      probability: totalPhysicalTiles ? group.count / totalPhysicalTiles : 0,
    })));
  });
}

function captureMutableState(game) {
  return {
    currentTile: game.currentTile,
    currentTileRotation: game.currentTile?.rotation ?? null,
    currentPlayerIndex: game.currentPlayerIndex,
    lastPlaced: game.lastPlaced,
    lastPlacement: game.lastPlacement,
    previewMeeple: game.previewMeeple,
    phase: game.phase,
    turnMessage: game.turnMessage,
    lastScoreResults: game.lastScoreResults,
    scoredFeatureKeys: new Set(game.scoredFeatureKeys),
    playerValues: game.players.map((player) => ({ player, score: player.score, meeples: player.meeples })),
    // 점수 처리에서 기존 미플 배열은 교체될 수 있으므로, 미플이 있는 타일의 원래 배열 참조만 보존합니다.
    boardMeeples: game.board.values()
      .filter((placed) => placed.meeples.length > 0)
      .map((placed) => ({ placed, meeples: placed.meeples })),
    historyPendingBranch: game.history.pendingBranch,
  };
}

function restoreMutableState(game, saved) {
  for (const { player, score, meeples } of saved.playerValues) {
    player.score = score;
    player.meeples = meeples;
  }
  for (const { placed, meeples } of saved.boardMeeples) placed.meeples = meeples;
  game.currentTile = saved.currentTile;
  if (game.currentTile && saved.currentTileRotation !== null) game.currentTile.rotation = saved.currentTileRotation;
  game.currentPlayerIndex = saved.currentPlayerIndex;
  game.lastPlaced = saved.lastPlaced;
  game.lastPlacement = saved.lastPlacement;
  game.previewMeeple = saved.previewMeeple;
  game.phase = saved.phase;
  game.turnMessage = saved.turnMessage;
  game.lastScoreResults = saved.lastScoreResults;
  game.scoredFeatureKeys = saved.scoredFeatureKeys;
  game.history.pendingBranch = saved.historyPendingBranch;
}

function pushPatch(session, patch) {
  patch.parentVersion = session.currentStateVersion;
  patch.version = session.nextStateVersion;
  session.nextStateVersion += 1;
  session.currentStateVersion = patch.version;
  session.patchStack.push(patch);
  session.performanceCounters.maximumPatchDepth = Math.max(
    session.performanceCounters.maximumPatchDepth,
    session.patchStack.length,
  );
  return patch;
}

function assertRestored(session, game, expectedKey, label) {
  if (!session.verifyRestoration) return;
  const actualKey = createSearchStateKey(game);
  if (actualKey !== expectedKey) throw new Error(`${label} 복원 뒤 탐색 상태가 원래 상태와 다릅니다.`);
}

// 전체 상태 복사 대신 이번 행동이 바꿀 수 있는 필드만 패치로 저장합니다.
export function applySearchAction(session, game, action, { mode = "placement" } = {}) {
  if (session.disposed) throw new Error("이미 정리된 탐색 세션은 사용할 수 없습니다.");
  const beforeKey = session.verifyRestoration ? createSearchStateKey(game) : null;
  const patch = {
    kind: "action",
    mode,
    saved: captureMutableState(game),
    placed: null,
    beforeKey,
  };
  const rollbackFailedAction = () => {
    if (patch.placed && game.board.get(patch.placed.x, patch.placed.y) === patch.placed) {
      game.board.remove(patch.placed.x, patch.placed.y);
    }
    restoreMutableState(game, patch.saved);
    assertRestored(session, game, patch.beforeKey, "실패한 행동");
    return null;
  };
  try {
    let applied = false;
    if (mode === "meeple") {
      if (game.previewMeeple) game.cancelMeeple({ notify: false });
      if (action.regionId && !game.toggleMeeple(action.regionId)) return rollbackFailedAction();
      game.finishTurn();
      applied = true;
    } else {
      if (!game.currentTile) return rollbackFailedAction();
      game.currentTile.rotation = action.rotation;
      if (!game.placeCurrentTile(action.x, action.y)) return rollbackFailedAction();
      patch.placed = game.lastPlaced;
      if (action.regionId && !game.toggleMeeple(action.regionId)) return rollbackFailedAction();
      game.finishTurn();
      applied = true;
    }
    if (!applied) return rollbackFailedAction();
    session.performanceCounters.actionApplyCount += 1;
    session.performanceCounters.simulationStateCount += 1;
    return pushPatch(session, patch);
  } catch (error) {
    rollbackFailedAction();
    throw error;
  }
}

export function undoSearchAction(session, game, patch) {
  if (!patch) return false;
  if (session.patchStack.at(-1) !== patch) throw new Error("탐색 행동은 적용의 역순으로 복원해야 합니다.");
  if (patch.placed && game.board.get(patch.placed.x, patch.placed.y) === patch.placed) {
    game.board.remove(patch.placed.x, patch.placed.y);
  }
  restoreMutableState(game, patch.saved);
  session.patchStack.pop();
  session.currentStateVersion = patch.parentVersion;
  session.performanceCounters.actionUndoCount += 1;
  assertRestored(session, game, patch.beforeKey, "행동");
  return true;
}

// 후보 상태의 덱에서 지정 종류 한 장만 빼고 A의 임시 턴을 만듭니다.
export function applyOpponentDraw(session, game, targetPlayerId, tileTypeId) {
  const targetIndex = game.players.findIndex((player) => player.id === targetPlayerId);
  const deckIndex = game.deck.findIndex((tile) => createTileTypeId(tile.definition) === tileTypeId);
  if (targetIndex < 0 || deckIndex < 0) return null;
  const beforeKey = session.verifyRestoration ? createSearchStateKey(game) : null;
  const drawnTile = game.deck[deckIndex];
  const patch = {
    kind: "draw",
    beforeKey,
    deckIndex,
    drawnTile,
    drawnRotation: drawnTile.rotation,
    currentPlayerIndex: game.currentPlayerIndex,
    currentTile: game.currentTile,
    lastPlaced: game.lastPlaced,
    lastPlacement: game.lastPlacement,
    previewMeeple: game.previewMeeple,
    lastScoreResults: game.lastScoreResults,
    phase: game.phase,
  };
  game.deck.splice(deckIndex, 1);
  drawnTile.rotation = 0;
  game.currentPlayerIndex = targetIndex;
  game.currentTile = drawnTile;
  game.lastPlaced = null;
  game.lastPlacement = null;
  game.previewMeeple = null;
  game.lastScoreResults = [];
  game.phase = PHASE.ROTATE_OR_PLACE;
  session.performanceCounters.drawApplyCount += 1;
  return pushPatch(session, patch);
}

export function undoOpponentDraw(session, game, patch) {
  if (!patch) return false;
  if (session.patchStack.at(-1) !== patch) throw new Error("가상 타일 뽑기는 적용의 역순으로 복원해야 합니다.");
  game.deck.splice(patch.deckIndex, 0, patch.drawnTile);
  patch.drawnTile.rotation = patch.drawnRotation;
  game.currentPlayerIndex = patch.currentPlayerIndex;
  game.currentTile = patch.currentTile;
  game.lastPlaced = patch.lastPlaced;
  game.lastPlacement = patch.lastPlacement;
  game.previewMeeple = patch.previewMeeple;
  game.lastScoreResults = patch.lastScoreResults;
  game.phase = patch.phase;
  session.patchStack.pop();
  session.currentStateVersion = patch.parentVersion;
  session.performanceCounters.drawUndoCount += 1;
  assertRestored(session, game, patch.beforeKey, "가상 타일 뽑기");
  return true;
}

export function getCachedTransition(session, key, calculate) {
  return cacheLookup(session, "transition", session.transitionCache, key, calculate);
}

export function getCachedBestResponse(session, key) {
  const stats = session.performanceCounters.cacheStats.bestResponse;
  if (!session.bestResponseCache.has(key)) {
    stats.misses += 1;
    session.performanceCounters.cacheMisses += 1;
    return null;
  }
  stats.hits += 1;
  session.performanceCounters.cacheHits += 1;
  return session.bestResponseCache.get(key);
}

export function setCachedBestResponse(session, key, result) {
  const frozen = Object.freeze({
    ...result,
    bestAction: result.bestAction ? Object.freeze({ ...result.bestAction }) : null,
  });
  session.bestResponseCache.set(key, frozen);
  return frozen;
}

export function recordCompactSearchResult(session, evaluation) {
  const started = now();
  const compact = Object.freeze({
    action: Object.freeze({ ...evaluation.action }),
    selfValue: evaluation.selfValue,
    expectedResponse: evaluation.expectedResponse,
    value: evaluation.value,
    tileResponseCount: evaluation.tileResponses.length,
  });
  session.compactLogData.push(compact);
  session.performanceCounters.compactLogRecordCount += 1;
  session.performanceCounters.compactLogBuildTimeMs += now() - started;
  return compact;
}

export function noteResultState(session, stateKey) {
  if (session.seenResultStates.has(stateKey)) session.performanceCounters.duplicateStateCount += 1;
  else session.seenResultStates.add(stateKey);
}

export function disposeSearchSession(session) {
  if (!session || session.disposed) return;
  if (session.patchStack.length) throw new Error("탐색 패치가 남아 있어 세션을 안전하게 정리할 수 없습니다.");
  const finalRootKey = createSearchStateKey(session.rootState);
  if (finalRootKey !== session.rootStateId) throw new Error("탐색 완료 뒤 루트 상태가 변경되었습니다.");
  for (const cache of [
    session.legalActionsCache,
    session.stateValueCache,
    session.futureValueCache,
    session.transitionCache,
    session.bestResponseCache,
    session.placeableTileCache,
    session.stateKeyByVersion,
  ]) cache.clear();
  session.compactLogData.length = 0;
  session.seenResultStates.clear();
  session.rootState = null;
  session.disposed = true;
}

export function cloneForBaseline(game, counters) {
  return cloneGame(game, counters, { includeAiDebug: true });
}

export function createBaselineCounters() {
  return createPerformanceCounters();
}
