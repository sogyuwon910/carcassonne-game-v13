import { getAiProfile } from "./aiProfiles.js";
import { PHASE } from "./config.js";
import { AI_STRATEGIES } from "./aiStrategies.js";
import { cloneHistoryData } from "./history.js";

export {
  calculateActionMetrics,
  calculateCompletedScoreValue,
  calculateFutureValue,
  calculateImmediateValue,
  calculateIncompleteScoreValue,
  calculateRemainingOwnTurns,
  calculateReturnedMeeples,
  calculateScoreComponents,
  completionProbability,
  countTilesForPosition,
  evaluateState,
} from "./aiValues.js";
export { AI_STRATEGIES } from "./aiStrategies.js";

// 현재 뽑은 타일로 가능한 '타일 배치 + 미플 선택' 합법 행동을 기존 규칙 함수로 생성합니다.
export function generateLegalActions(game) {
  if (!game.currentTile) return [];
  const actions = [];
  for (const placement of game.board.getAllLegalPlacements(game.currentTile)) {
    const temporary = game.cloneForSimulation();
    temporary.listeners.clear();
    temporary.currentTile.rotation = placement.rotation;
    if (!temporary.placeCurrentTile(placement.x, placement.y)) continue;
    actions.push({ ...placement, regionId: null, featureType: null });
    for (const region of temporary.getMeepleOptions()) {
      actions.push({ ...placement, regionId: region.id, featureType: region.type });
    }
  }
  return actions;
}

// 사람이 타일을 놓은 뒤 조언할 때는 현재 위치에서 미플/건너뛰기 합법 행동만 생성합니다.
export function generateMeepleActions(game) {
  if (game.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !game.lastPlaced) return [];
  const temporary = game.cloneForSimulation();
  temporary.listeners.clear();
  if (temporary.previewMeeple) temporary.cancelMeeple({ notify: false });
  const { x, y, tile } = temporary.lastPlaced;
  const actions = [{ x, y, rotation: tile.rotation, regionId: null, featureType: null }];
  for (const region of temporary.getMeepleOptions()) {
    actions.push({ x, y, rotation: tile.rotation, regionId: region.id, featureType: region.type });
  }
  return actions;
}

function simulateMeepleAction(game, action) {
  const simulated = game.cloneForSimulation();
  simulated.listeners.clear();
  if (simulated.previewMeeple) simulated.cancelMeeple({ notify: false });
  if (action.regionId && !simulated.toggleMeeple(action.regionId)) return null;
  simulated.finishTurn();
  return simulated;
}

function buildDebug(
  profile,
  strategy,
  game,
  context,
  actions,
  filteredActions,
  evaluations,
  selection = null,
  evaluatedCandidateCount = evaluations.length,
) {
  const selected = selection?.evaluation ?? null;
  const strategyDescription = strategy.describeStrategy(
    context,
    selected,
    evaluations,
    selection ?? { reason: "후보 행동 평가 중", tiedCount: 0 },
  );
  return cloneHistoryData({
    profileId: profile.id,
    profileName: profile.name,
    strategyId: strategy.id,
    strategyName: strategy.strategyName,
    tileId: game.currentTile?.definition.id ?? game.lastPlaced?.tile.definition.id,
    candidateCount: actions.length,
    filteredCandidateCount: filteredActions.length,
    evaluatedCandidateCount,
    selectedAction: selected?.action ?? null,
    selectedValue: selected?.value ?? null,
    selectedReason: selection?.reason ?? "후보 행동 평가 중",
    context,
    strategyDescription,
    evaluations,
  });
}

async function chooseWithStrategy(game, profile, mode, { random, onPrepared, onProgress, shouldCancel } = {}) {
  const strategy = resolveAiStrategy(profile.id);
  const playerId = game.currentPlayer?.id;
  const randomSource = typeof random === "function"
    ? random
    : typeof game.random === "function"
      ? game.random
      : Math.random;
  const searchSession = typeof strategy.createSearchSession === "function"
    ? strategy.createSearchSession(game, { playerId, mode })
    : null;
  let context = null;
  try {
    context = strategy.prepareTurnContext(game, playerId, randomSource, searchSession);
    const actions = typeof strategy.generateActions === "function"
      ? strategy.generateActions(game, mode, searchSession)
      : mode === "meeple" ? generateMeepleActions(game) : generateLegalActions(game);
    const filteredActions = strategy.filterActions(actions, game, context);
    if (context.progress) {
      context.progress.totalCandidates = filteredActions.length;
      context.progress.percent = filteredActions.length ? 0 : 100;
    }
    if (typeof onPrepared === "function") {
      const logStarted = globalThis.performance?.now?.() ?? Date.now();
      const preparedDebug = buildDebug(profile, strategy, game, context, actions, filteredActions, []);
      if (searchSession) searchSession.performanceCounters.progressLogBuildTimeMs +=
        (globalThis.performance?.now?.() ?? Date.now()) - logStarted;
      onPrepared(preparedDebug);
    }

    let evaluations = [];
    let selection;
    let cancelled = false;
    let lastProgressRender = 0;
    if (typeof strategy.evaluateTurn === "function") {
      const turnResult = await strategy.evaluateTurn(game, filteredActions, context, {
        mode,
        random: randomSource,
        searchSession,
        shouldCancel: typeof shouldCancel === "function" ? shouldCancel : () => false,
        onProgress: ({ completedEvaluationCount = 0 }) => {
          if (typeof onProgress !== "function") return;
          const renderTime = globalThis.performance?.now?.() ?? Date.now();
          if (renderTime - lastProgressRender < 90 && completedEvaluationCount < filteredActions.length) return;
          lastProgressRender = renderTime;
          const logStarted = renderTime;
          // 탐색 중에는 상세 후보 배열을 복사하거나 HTML로 만들지 않고 진행 숫자만 전달합니다.
          const compactDebug = buildDebug(
            profile,
            strategy,
            game,
            context,
            actions,
            filteredActions,
            [],
            null,
            completedEvaluationCount,
          );
          if (searchSession) searchSession.performanceCounters.progressLogBuildTimeMs +=
            (globalThis.performance?.now?.() ?? Date.now()) - logStarted;
          onProgress(compactDebug);
        },
      });
      evaluations = turnResult.evaluations;
      selection = turnResult.selection;
      cancelled = turnResult.cancelled;
    } else {
      for (let index = 0; index < filteredActions.length; index += 1) {
        if (typeof shouldCancel === "function" && shouldCancel()) { cancelled = true; break; }
        const action = filteredActions[index];
        const simulated = mode === "meeple"
          ? simulateMeepleAction(game, action)
          : game.simulateAction(action);
        if (!simulated) continue;
        evaluations.push(strategy.evaluateAction(game, action, simulated, context));
        // 후보가 많아도 브라우저 렌더링이 완전히 멈추지 않도록 제어권을 잠깐 돌려줍니다.
        if (index > 0 && index % 18 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      selection = cancelled
        ? { evaluation: null, reason: "게임 상태가 변경되어 탐색을 취소함", tiedCount: 0 }
        : strategy.selectAction(evaluations, context, randomSource);
    }
    const logStarted = globalThis.performance?.now?.() ?? Date.now();
    const debug = buildDebug(profile, strategy, game, context, actions, filteredActions, evaluations, selection);
    const finalLogTime = (globalThis.performance?.now?.() ?? Date.now()) - logStarted;
    if (searchSession) {
      searchSession.performanceCounters.finalLogBuildTimeMs += finalLogTime;
      if (debug.context?.performanceCounters) debug.context.performanceCounters.finalLogBuildTimeMs =
        searchSession.performanceCounters.finalLogBuildTimeMs;
    }
    return {
      action: selection.evaluation?.action ?? null,
      evaluation: selection.evaluation ?? null,
      debug,
      cancelled,
    };
  } finally {
    if (searchSession && typeof strategy.disposeSearchSession === "function") {
      strategy.disposeSearchSession(searchSession, context);
    }
  }
}

export function resolveAiStrategy(profileId) {
  const profile = getAiProfile(profileId);
  return AI_STRATEGIES[profile.strategyId] ?? AI_STRATEGIES.basic;
}

// 실제 AI 턴. onPrepared를 쓰면 평가가 끝나기 전에도 이번 턴의 전략 조건을 로그에 표시할 수 있습니다.
export async function chooseAiAction(game, profileId = game.currentPlayer?.aiProfileId, options = {}) {
  const profile = getAiProfile(profileId);
  return chooseWithStrategy(game, profile, "placement", options);
}

// 사람의 조언은 전체 상태 복사본에서만 계산합니다. 미플 미리보기 역시 복사본에서 되돌립니다.
export async function chooseAiAdvice(game, profileId, options = {}) {
  const profile = getAiProfile(profileId);
  // 이 전략은 자체 탐색 세션이 루트 상태를 한 번 복사하므로 조언용 선복사를 중복하지 않습니다.
  if (profile.strategyId === "gameTheoryBestResponse") {
    if ([PHASE.ROTATE_OR_PLACE, PHASE.PLACE_MEEPLE_OR_SKIP].includes(game.phase)) {
      return chooseWithStrategy(game, profile, game.phase === PHASE.ROTATE_OR_PLACE ? "placement" : "meeple", {
        ...options,
        random: options.random ?? Math.random,
      });
    }
  }
  const copiedGame = game.cloneForSimulation();
  copiedGame.listeners.clear();
  if (copiedGame.phase === PHASE.ROTATE_OR_PLACE) {
    return chooseWithStrategy(copiedGame, profile, "placement", {
      ...options,
      random: options.random ?? Math.random,
    });
  }
  if (copiedGame.phase === PHASE.PLACE_MEEPLE_OR_SKIP) {
    if (copiedGame.previewMeeple) copiedGame.cancelMeeple({ notify: false });
    return chooseWithStrategy(copiedGame, profile, "meeple", {
      ...options,
      random: options.random ?? Math.random,
    });
  }
  const strategy = resolveAiStrategy(profile.id);
  return {
    action: null,
    evaluation: null,
    debug: {
      profileId: profile.id,
      profileName: profile.name,
      strategyId: strategy.id,
      strategyName: strategy.strategyName,
      candidateCount: 0,
      filteredCandidateCount: 0,
      evaluatedCandidateCount: 0,
      selectedAction: null,
      selectedValue: null,
      selectedReason: "현재 단계에서는 조언할 수 없음",
      evaluations: [],
    },
  };
}
