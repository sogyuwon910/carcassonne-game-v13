import { FEATURE } from "./config.js";
import {
  calculateActionMetrics,
  calculateFutureValue,
  calculateIncompleteScoreValue,
  calculateRemainingOwnTurns,
  calculateScoreComponents,
} from "./aiValues.js";
import { gameTheoryBestResponseStrategy } from "./gameTheoryBestResponse.js";
import { kimGyuminStrategy } from "./kimGyuminStrategy.js";

const VALUE_EPSILON = 1e-9;

function randomIndex(length, random) {
  if (length <= 1) return 0;
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(value, 1 - Number.EPSILON)) : 0;
  return Math.floor(normalized * length);
}

export function chooseRandom(items, random) {
  return items.length ? items[randomIndex(items.length, random)] : null;
}

export function selectMaximumValue(evaluations, random, reason = "V_i가 최대인 후보를 선택") {
  if (!evaluations.length) return { evaluation: null, reason: "평가 가능한 합법 행동이 없음", tiedCount: 0 };
  const maximum = Math.max(...evaluations.map((item) => item.value));
  const best = evaluations.filter((item) => Math.abs(item.value - maximum) < VALUE_EPSILON);
  return {
    evaluation: chooseRandom(best, random),
    reason: best.length > 1 ? `${reason} · 최대값 동점 ${best.length}개 중 무작위 선택` : reason,
    tiedCount: best.length,
  };
}

function baseContext(game, playerId) {
  const player = game.players.find((item) => item.id === playerId);
  return {
    playerId,
    playerName: player?.name ?? `플레이어 ${playerId + 1}`,
    meeplesBefore: player?.meeples ?? 0,
    remainingOwnTurns: calculateRemainingOwnTurns(game),
  };
}

function evaluateBase(game, action, simulated, context) {
  return { action, ...calculateActionMetrics(game, simulated, action, context.playerId) };
}

function makeStandardStrategy(id, strategyName) {
  return Object.freeze({
    id,
    strategyName,
    valueFormula: "V_i = I_i + F_i",
    prepareTurnContext(game, playerId) {
      return baseContext(game, playerId);
    },
    filterActions(actions) {
      return actions;
    },
    evaluateAction(game, action, simulated, context) {
      const evaluation = evaluateBase(game, action, simulated, context);
      return { ...evaluation, value: evaluation.immediate + evaluation.future };
    },
    selectAction(evaluations, context, random) {
      return selectMaximumValue(evaluations, random);
    },
    describeStrategy(context, selectedEvaluation, evaluations, selection) {
      return {
        valueFormula: this.valueFormula,
        mainConditions: ["특수 후보 제한 없음", "모든 합법 행동을 기본 가치로 비교"],
        selectionReason: selection.reason,
      };
    },
  });
}

const basicStrategy = makeStandardStrategy("basic", "기본 전략");
const heoSeoyeonStrategy = makeStandardStrategy("heo-seoyeon", "허서연 기본 전략");
const soGyuwonStrategy = makeStandardStrategy("so-gyuwon", "소규원 기본 전략");

const leeSuwanStrategy = Object.freeze({
  id: "lee-suwan",
  strategyName: "이수완 가중치·미플 확률 전략",
  prepareTurnContext(game, playerId, random) {
    const context = baseContext(game, playerId);
    context.k = randomIndex(7, random) + 1;
    context.kAtMostMeeples = context.k <= context.meeplesBefore;
    context.meepleProbability = context.meeplesBefore === 0
      ? 0
      : Math.min(1, context.meeplesBefore / context.k);
    context.meepleProbabilityRoll = null;
    context.meeplePlacementDecision = null;
    if (context.meeplesBefore <= 3) {
      if (context.meeplesBefore === 0) context.meeplePlacementDecision = false;
      else if (context.meepleProbability >= 1) context.meeplePlacementDecision = true;
      else {
        context.meepleProbabilityRoll = random();
        context.meeplePlacementDecision = context.meepleProbabilityRoll < context.meepleProbability;
      }
    }
    context.valueFormula = context.kAtMostMeeples
      ? "V_i = (2/3) × I_i + (4/3) × F_i"
      : "V_i = (4/3) × I_i + (2/3) × F_i";
    return context;
  },
  filterActions(actions, game, context) {
    if (context.meeplesBefore > 3) {
      context.meepleFilterResult = "m > 3이므로 확률 후보 제한 없음";
      return actions;
    }
    if (!context.meeplePlacementDecision) {
      context.meepleFilterResult = "미플 미배치 판정에 따라 미플 없는 후보만 유지";
      return actions.filter((action) => !action.regionId);
    }
    const meepleActions = actions.filter((action) => action.regionId);
    if (meepleActions.length) {
      context.meepleFilterResult = "미플 배치 판정에 따라 합법 미플 후보만 유지";
      return meepleActions;
    }
    context.meepleFilterResult = "합법 미플 후보가 없어 미플 미배치 후보로 전환";
    return actions.filter((action) => !action.regionId);
  },
  evaluateAction(game, action, simulated, context) {
    const evaluation = evaluateBase(game, action, simulated, context);
    const value = context.kAtMostMeeples
      ? (2 / 3) * evaluation.immediate + (4 / 3) * evaluation.future
      : (4 / 3) * evaluation.immediate + (2 / 3) * evaluation.future;
    return { ...evaluation, value };
  },
  selectAction(evaluations, context, random) {
    return selectMaximumValue(evaluations, random);
  },
  describeStrategy(context, selectedEvaluation, evaluations, selection) {
    const roll = context.meepleProbabilityRoll === null
      ? "난수 판정 불필요"
      : `판정 난수 ${context.meepleProbabilityRoll.toFixed(4)}`;
    return {
      valueFormula: context.valueFormula,
      mainConditions: [
        `턴 시작 m=${context.meeplesBefore}, k=${context.k}, k <= m: ${context.kAtMostMeeples ? "예" : "아니요"}`,
        `미플 배치 확률 ${(context.meepleProbability * 100).toFixed(2)}% · ${roll} · 결과: ${context.meeplePlacementDecision === null ? "제한 없음" : context.meeplePlacementDecision ? "배치" : "미배치"}`,
        context.meepleFilterResult,
      ],
      selectionReason: selection.reason,
    };
  },
});

function chooseJeongTarget(game, playerId, random) {
  const playerValues = game.players.map((player) => {
    const scores = calculateScoreComponents(game, player.id);
    return { playerId: player.id, playerName: player.name, ...scores, value: scores.immediate + scores.future };
  });
  const maximum = Math.max(...playerValues.map((item) => item.value));
  const valueTies = playerValues.filter((item) => Math.abs(item.value - maximum) < VALUE_EPSILON);
  const maximumFuture = Math.max(...valueTies.map((item) => item.future));
  const futureTies = valueTies.filter((item) => Math.abs(item.future - maximumFuture) < VALUE_EPSILON);
  const target = chooseRandom(futureTies, random);
  const tieProcess = valueTies.length === 1
    ? "V 최고 플레이어가 한 명"
    : futureTies.length === 1
      ? `V 동점 ${valueTies.length}명 → F 최고 플레이어 선택`
      : `V 동점 ${valueTies.length}명 → F 동점 ${futureTies.length}명 중 무작위 선택`;
  return { playerValues, target, tieProcess, valueTies, futureTies };
}

const jeongJaeiStrategy = Object.freeze({
  id: "jeong-jaei",
  strategyName: "정재이 선두 미래가치 견제 전략",
  prepareTurnContext(game, playerId, random) {
    const context = baseContext(game, playerId);
    const targetResult = chooseJeongTarget(game, playerId, random);
    context.playerValues = targetResult.playerValues;
    context.targetPlayerId = targetResult.target.playerId;
    context.targetPlayerName = targetResult.target.playerName;
    context.targetIsSelf = context.targetPlayerId === playerId;
    context.targetTieProcess = targetResult.tieProcess;
    context.valueFormula = context.targetIsSelf
      ? "V_i = I_self(S_i) + F_self(S_i)"
      : "V_i = I_self(S_i) + F_self(S_i) - F_A(S_i)";
    return context;
  },
  filterActions(actions) {
    return actions;
  },
  evaluateAction(game, action, simulated, context) {
    const evaluation = evaluateBase(game, action, simulated, context);
    const targetFuture = calculateFutureValue(simulated, context.targetPlayerId).total;
    const value = evaluation.immediate + evaluation.future - (context.targetIsSelf ? 0 : targetFuture);
    return { ...evaluation, targetFuture, value };
  },
  selectAction(evaluations, context, random) {
    return selectMaximumValue(evaluations, random);
  },
  describeStrategy(context, selectedEvaluation, evaluations, selection) {
    return {
      valueFormula: context.valueFormula,
      mainConditions: [
        `기준 플레이어 A: ${context.targetPlayerName} (${context.targetIsSelf ? "자신" : "상대"})`,
        context.targetTieProcess,
        context.targetIsSelf ? "기본 가치 사용" : "상대의 F_A(S_i)만 차감",
      ],
      playerValues: context.playerValues,
      selectionReason: selection.reason,
    };
  },
});

const jangSeongiStrategy = Object.freeze({
  id: "jang-seongi",
  strategyName: "장성이 수도원·미플 가치 전략",
  valueFormula: "V_i = 2 × C_i + N_i + F_i + M_i, M_i = 5 / (m_i + 1)",
  prepareTurnContext(game, playerId) {
    const context = baseContext(game, playerId);
    const tile = game.currentTile ?? game.lastPlaced?.tile;
    context.isMonasteryTile = Boolean(tile?.definition.monastery);
    context.monasteryMeepleForced = false;
    return context;
  },
  filterActions(actions, game, context) {
    if (!context.isMonasteryTile || context.meeplesBefore <= 0) return actions;
    const monasteryActions = actions.filter((action) => action.regionId && action.featureType === FEATURE.MONASTERY);
    if (monasteryActions.length) {
      context.monasteryMeepleForced = true;
      return monasteryActions;
    }
    return actions;
  },
  evaluateAction(game, action, simulated, context) {
    const evaluation = evaluateBase(game, action, simulated, context);
    const meepleValue = 5 / (evaluation.meeplesAfter + 1);
    const value = 2 * evaluation.completed + evaluation.incomplete + evaluation.future + meepleValue;
    return { ...evaluation, meepleValue, value };
  },
  selectAction(evaluations, context, random) {
    return selectMaximumValue(evaluations, random);
  },
  describeStrategy(context, selectedEvaluation, evaluations, selection) {
    return {
      valueFormula: this.valueFormula,
      mainConditions: [
        `현재 타일 수도원: ${context.isMonasteryTile ? "예" : "아니요"}`,
        `수도원 미플 강제 배치: ${context.monasteryMeepleForced ? "적용" : "미적용"}`,
      ],
      selectionReason: selection.reason,
    };
  },
});

const sonGeonhuStrategy = Object.freeze({
  id: "son-geonhu",
  strategyName: "손건후 미플 소진·회수 전략",
  valueFormula: "V_i = I_i + F_i + M_i, M_i = 5 / (m_i + 1) + 2 × r_i",
  prepareTurnContext(game, playerId) {
    const context = baseContext(game, playerId);
    context.currentIncomplete = calculateIncompleteScoreValue(game, playerId);
    context.turnCondition = context.remainingOwnTurns <= context.meeplesBefore;
    context.lowMeepleCondition = context.meeplesBefore >= 0
      && context.meeplesBefore <= 2
      && context.currentIncomplete >= 5;
    context.forceMeepleRequested = context.meeplesBefore > 0
      && (context.turnCondition || context.lowMeepleCondition);
    context.forceMeepleApplied = false;
    const reasons = [];
    if (context.turnCondition) reasons.push("남은 자기 턴 수 <= 현재 미플 수");
    if (context.lowMeepleCondition) reasons.push("0 <= m <= 2이고 N_self(S) >= 5");
    context.forceMeepleReasons = reasons;
    return context;
  },
  filterActions(actions, game, context) {
    if (!context.forceMeepleRequested) return actions;
    const meepleActions = actions.filter((action) => action.regionId);
    if (!meepleActions.length) return actions;
    context.forceMeepleApplied = true;
    return meepleActions;
  },
  evaluateAction(game, action, simulated, context) {
    const evaluation = evaluateBase(game, action, simulated, context);
    const meepleValue = 5 / (evaluation.meeplesAfter + 1) + 2 * evaluation.returnedMeeples;
    const value = evaluation.immediate + evaluation.future + meepleValue;
    return { ...evaluation, meepleValue, value };
  },
  selectAction(evaluations, context, random) {
    return selectMaximumValue(evaluations, random);
  },
  describeStrategy(context, selectedEvaluation, evaluations, selection) {
    return {
      valueFormula: this.valueFormula,
      mainConditions: [
        `m=${context.meeplesBefore}, 남은 자기 턴=${context.remainingOwnTurns}, N_self(S)=${context.currentIncomplete.toFixed(2)}`,
        `미플 강제 배치: ${context.forceMeepleApplied ? "적용" : "미적용"}${context.forceMeepleReasons.length ? ` · ${context.forceMeepleReasons.join(" / ")}` : ""}`,
        context.forceMeepleRequested && !context.forceMeepleApplied ? "합법 미플 후보가 없어 일반 후보 허용" : "강제 후보 대체 없음",
      ],
      selectionReason: selection.reason,
    };
  },
});

export const AI_STRATEGIES = Object.freeze({
  basic: basicStrategy,
  "heo-seoyeon": heoSeoyeonStrategy,
  "lee-suwan": leeSuwanStrategy,
  "jeong-jaei": jeongJaeiStrategy,
  "son-geonhu": sonGeonhuStrategy,
  "kim-gyumin": kimGyuminStrategy,
  "jang-seongi": jangSeongiStrategy,
  "so-gyuwon": soGyuwonStrategy,
  gameTheoryBestResponse: gameTheoryBestResponseStrategy,
});
