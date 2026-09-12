import { describe, expect, it, vi } from "vitest";
import { Board } from "../js/board.js";
import {
  calculateCompletedScoreValue,
  calculateFutureValue,
  calculateImmediateValue,
  calculateIncompleteScoreValue,
  calculateRemainingOwnTurns,
  calculateReturnedMeeples,
  chooseAiAction,
  chooseAiAdvice,
  evaluateState,
  generateLegalActions,
  resolveAiStrategy,
} from "../js/ai.js";
import { AI_PROFILES } from "../js/aiProfiles.js";
import { FEATURE } from "../js/config.js";
import { GameEngine } from "../js/game.js";
import { estimateEndScoreForPlayer } from "../js/scoring.js";
import { TileDefinition, TileInstance } from "../js/tile.js";
import { renderAiStrategyReport } from "../js/ui.js";

function definition({ id, edges = { 1: "F", 2: "F", 3: "F", 4: "F" }, city = [], monastery = false, count = 1 }) {
  return new TileDefinition({
    id,
    count,
    draw_count: count,
    edges,
    city_groups: city,
    road_groups: [],
    monastery,
  });
}

const field = definition({ id: 1 });
const monastery = definition({ id: 2, monastery: true, count: 2 });
const eastCity = definition({ id: 3, edges: { 1: "F", 2: "C", 3: "F", 4: "F" }, city: [[2]] });
const westCity = definition({ id: 4, edges: { 1: "F", 2: "F", 3: "F", 4: "C" }, city: [[4]] });

function plainGame({ scores = [0, 0], meeples = [7, 7], deckLength = 0, board = new Board(), deck = null, monasteryTile = false } = {}) {
  return {
    board,
    players: scores.map((score, id) => ({ id, name: `P${id}`, score, meeples: meeples[id] ?? 7 })),
    deck: deck ?? Array.from({ length: deckLength }, () => new TileInstance(field)),
    currentTile: new TileInstance(monasteryTile ? monastery : field),
    lastPlaced: null,
  };
}

function valueGames({ selfScore = 4, targetScore = 0, beforeMeeples = 5, afterMeeples = 5 } = {}) {
  return {
    original: plainGame({ scores: [selfScore, targetScore], meeples: [beforeMeeples, 7] }),
    simulated: plainGame({ scores: [selfScore, targetScore], meeples: [afterMeeples, 7] }),
  };
}

function makePlayableGame(profileId = "basic", random = () => 0.99) {
  const game = new GameEngine([field, monastery], { random });
  game.startGame([
    { type: "ai", aiProfileId: profileId },
    { name: "상대", type: "human" },
  ]);
  return game;
}

describe("AI 공통 점수 요소와 상태 복사", () => {
  it("I_p(S)는 분리된 C_p(S)와 N_p(S)의 합이고 기존 계산 결과를 유지한다", () => {
    const board = new Board();
    const placed = board.place(new TileInstance(monastery), 0, 0);
    placed.meeples.push({ playerId: 0, type: FEATURE.MONASTERY, regionId: "monastery-0", x: 0.5, y: 0.5 });
    board.place(new TileInstance(field), 1, 0);
    const game = plainGame({ scores: [8, 2], board });

    const completed = calculateCompletedScoreValue(game, 0);
    const incomplete = calculateIncompleteScoreValue(game, 0);
    expect(completed).toBe(8);
    expect(incomplete).toBe(2);
    expect(calculateImmediateValue(game, 0)).toBe(completed + incomplete);
    expect(calculateImmediateValue(game, 0)).toBe(8 + estimateEndScoreForPlayer(board, 0));
  });

  it("기본 AI의 V=I+F 결과는 계산 분리 전 공식과 동일하다", () => {
    const game = plainGame({ scores: [6, 1], deckLength: 3 });
    const state = evaluateState(game, 0);
    const oldImmediate = game.players[0].score + estimateEndScoreForPlayer(game.board, 0);
    expect(state.immediate).toBe(oldImmediate);
    expect(state.value).toBeCloseTo(oldImmediate + calculateFutureValue(game, 0).total);
  });

  it("후보 생성과 전체 후보 평가 뒤에도 원본 게임 상태가 바뀌지 않는다", async () => {
    const game = makePlayableGame("basic");
    const before = JSON.stringify(game.serializeState());
    expect(generateLegalActions(game).length).toBeGreaterThan(0);
    const result = await chooseAiAction(game, "basic");
    expect(result.action).toBeTruthy();
    expect(JSON.stringify(game.serializeState())).toBe(before);
  });

  it("남은 자기 턴 수는 이번 턴을 포함해 1+floor(덱/플레이어)로 계산한다", () => {
    expect(calculateRemainingOwnTurns(plainGame({ scores: [0, 0, 0], deckLength: 8 }))).toBe(3);
  });
});

describe("이수완 AI", () => {
  const strategy = resolveAiStrategy("lee-suwan");

  it("k를 턴 컨텍스트에서 정확히 한 번 뽑고 모든 평가에 재사용한다", () => {
    const random = vi.fn(() => 0.5);
    const game = plainGame({ meeples: [4, 7] });
    const context = strategy.prepareTurnContext(game, 0, random);
    expect(context.k).toBe(4);
    expect(context.kAtMostMeeples).toBe(true);
    expect(random).toHaveBeenCalledTimes(1);

    const { original, simulated } = valueGames({ selfScore: 9, beforeMeeples: 4, afterMeeples: 4 });
    strategy.evaluateAction(original, { regionId: null }, simulated, context);
    strategy.evaluateAction(original, { regionId: null }, simulated, context);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("k<=m과 k>m에서 지정된 비정규화 가치 공식을 사용한다", () => {
    const { original, simulated } = valueGames({ selfScore: 9, beforeMeeples: 4, afterMeeples: 4 });
    const lowK = strategy.evaluateAction(original, { regionId: null }, simulated, { playerId: 0, kAtMostMeeples: true });
    const highK = strategy.evaluateAction(original, { regionId: null }, simulated, { playerId: 0, kAtMostMeeples: false });
    expect(lowK.value).toBeCloseTo((2 / 3) * lowK.immediate + (4 / 3) * lowK.future);
    expect(highK.value).toBeCloseTo((4 / 3) * highK.immediate + (2 / 3) * highK.future);
    expect(highK.value).toBeCloseTo(12);
  });

  it("m<=3이면 m/k 확률을 한 번 판정해 미플 후보를 제한한다", () => {
    const random = vi.fn()
      .mockReturnValueOnce(0.5) // k=4
      .mockReturnValueOnce(0.49); // 2/4 확률에 성공
    const game = plainGame({ meeples: [2, 7] });
    const context = strategy.prepareTurnContext(game, 0, random);
    const noMeeple = { regionId: null };
    const meepleAction = { regionId: "monastery-0" };
    expect(context.meepleProbability).toBe(0.5);
    expect(context.meeplePlacementDecision).toBe(true);
    expect(strategy.filterActions([noMeeple, meepleAction], game, context)).toEqual([meepleAction]);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("배치 판정 뒤 합법 미플 후보가 없으면 미배치 후보로 정상 전환한다", () => {
    const game = plainGame({ meeples: [2, 7] });
    const context = strategy.prepareTurnContext(game, 0, () => 0); // k=1, 반드시 배치
    const noMeeple = { regionId: null };
    expect(strategy.filterActions([noMeeple], game, context)).toEqual([noMeeple]);
    expect(context.meepleFilterResult).toContain("전환");
  });
});

describe("정재이 AI", () => {
  const strategy = resolveAiStrategy("jeong-jaei");

  it("현재 기본 V가 가장 높은 플레이어를 A로 고른다", () => {
    const game = plainGame({ scores: [1, 7, 3] });
    const context = strategy.prepareTurnContext(game, 0, () => 0);
    expect(context.targetPlayerId).toBe(1);
  });

  it("V 동점이면 F가 높은 플레이어를 A로 고른다", () => {
    const board = new Board();
    const placed = board.place(new TileInstance(eastCity), 0, 0);
    placed.meeples.push({ playerId: 0, type: FEATURE.CITY, regionId: "city-0", x: 0.8, y: 0.5 });
    const game = plainGame({ scores: [0, 2], board, deck: [new TileInstance(westCity)] });
    const context = strategy.prepareTurnContext(game, 1, () => 0.99);
    expect(context.playerValues[0].value).toBeCloseTo(context.playerValues[1].value);
    expect(context.playerValues[0].future).toBeGreaterThan(context.playerValues[1].future);
    expect(context.targetPlayerId).toBe(0);
    expect(context.targetTieProcess).toContain("F 최고");
  });

  it("V와 F까지 동점이면 주입된 난수로 A를 한 번 선택한다", () => {
    const random = vi.fn(() => 0.8);
    const game = plainGame({ scores: [0, 0, 0] });
    const context = strategy.prepareTurnContext(game, 0, random);
    expect(context.targetPlayerId).toBe(2);
    expect(context.targetTieProcess).toContain("무작위");
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("A가 상대이면 상대 C나 N이 아니라 F_A(S_i)만 차감한다", () => {
    const { original, simulated } = valueGames({ selfScore: 5, targetScore: 100 });
    const evaluation = strategy.evaluateAction(original, { regionId: null }, simulated, {
      playerId: 0,
      targetPlayerId: 1,
      targetIsSelf: false,
    });
    expect(evaluation.targetFuture).toBe(0);
    expect(evaluation.value).toBe(evaluation.immediate + evaluation.future);
    expect(evaluation.value).toBe(5);
  });
});

describe("장성이 AI", () => {
  const strategy = resolveAiStrategy("jang-seongi");

  it("수도원 타일에서 가능하면 수도원 미플 후보만 남긴다", () => {
    const game = plainGame({ monasteryTile: true, meeples: [2, 7] });
    const context = strategy.prepareTurnContext(game, 0, () => 0);
    const actions = [
      { regionId: null, featureType: null },
      { regionId: "city-0", featureType: FEATURE.CITY },
      { regionId: "monastery-0", featureType: FEATURE.MONASTERY },
    ];
    expect(strategy.filterActions(actions, game, context)).toEqual([actions[2]]);
    expect(context.monasteryMeepleForced).toBe(true);
  });

  it("수도원 미플이 불가능하면 일반 후보를 유지한다", () => {
    const game = plainGame({ monasteryTile: true, meeples: [2, 7] });
    const context = strategy.prepareTurnContext(game, 0, () => 0);
    const actions = [{ regionId: null }, { regionId: "city-0", featureType: FEATURE.CITY }];
    expect(strategy.filterActions(actions, game, context)).toEqual(actions);
    expect(context.monasteryMeepleForced).toBe(false);
  });

  it("M=5/(m_i+1)과 V=2C+N+F+M을 정확히 계산한다", () => {
    const { original, simulated } = valueGames({ selfScore: 4, beforeMeeples: 3, afterMeeples: 2 });
    const evaluation = strategy.evaluateAction(original, { regionId: "monastery-0" }, simulated, { playerId: 0 });
    expect(evaluation.meepleValue).toBeCloseTo(5 / 3);
    expect(evaluation.value).toBeCloseTo(2 * evaluation.completed + evaluation.incomplete + evaluation.future + 5 / 3);
  });
});

describe("손건후 AI", () => {
  const strategy = resolveAiStrategy("son-geonhu");

  it("남은 자기 턴 수가 m 이하이면 합법 미플 후보를 강제한다", () => {
    const game = plainGame({ meeples: [3, 7], deckLength: 4 }); // 1+floor(4/2)=3
    const context = strategy.prepareTurnContext(game, 0, () => 0);
    const actions = [{ regionId: null }, { regionId: "monastery-0" }];
    expect(context.turnCondition).toBe(true);
    expect(strategy.filterActions(actions, game, context)).toEqual([actions[1]]);
    expect(context.forceMeepleApplied).toBe(true);
  });

  it("0<=m<=2이고 현재 N_self(S)>=5인 조건도 미플을 강제한다", () => {
    const board = new Board();
    const placed = board.place(new TileInstance(monastery), 0, 0);
    placed.meeples.push({ playerId: 0, type: FEATURE.MONASTERY, regionId: "monastery-0", x: 0.5, y: 0.5 });
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([x, y]) => board.place(new TileInstance(field), x, y));
    const game = plainGame({ meeples: [2, 7], deckLength: 20, board });
    const context = strategy.prepareTurnContext(game, 0, () => 0);
    expect(context.currentIncomplete).toBe(5);
    expect(context.lowMeepleCondition).toBe(true);
    expect(context.forceMeepleRequested).toBe(true);
  });

  it("r_i에는 자기 미플 변화만 포함하고 상대 미플 회수는 포함하지 않는다", () => {
    const original = plainGame({ meeples: [5, 1] });
    const simulated = plainGame({ meeples: [6, 7] });
    expect(calculateReturnedMeeples(5, simulated, 0, { regionId: null })).toBe(1);
  });

  it("M=5/(m_i+1)+2r_i와 최종 V를 정확히 계산한다", () => {
    const { original, simulated } = valueGames({ selfScore: 4, beforeMeeples: 5, afterMeeples: 6 });
    const evaluation = strategy.evaluateAction(original, { regionId: null }, simulated, { playerId: 0 });
    expect(evaluation.returnedMeeples).toBe(1);
    expect(evaluation.meepleValue).toBeCloseTo(5 / 7 + 2);
    expect(evaluation.value).toBeCloseTo(evaluation.immediate + evaluation.future + evaluation.meepleValue);
  });
});

describe("김규민 AI", () => {
  const strategy = resolveAiStrategy("kim-gyumin");

  it("누적 점수가 아니라 상대 F_p(S)로 방해 대상을 고른다", () => {
    const context = strategy.prepareTurnContext(plainGame({ scores: [100, 3, 8] }), 0, () => 0);
    expect(context.opponentFutures.every((item) => item.future === 0)).toBe(true);
    expect(context.targetPlayerId).toBe(1);
  });

  it("상대 F가 동점이면 주입된 난수로 한 명을 한 번 고른다", () => {
    const random = vi.fn(() => 0.9);
    const context = strategy.prepareTurnContext(plainGame({ scores: [100, 8, 8] }), 0, random);
    expect(context.targetPlayerId).toBe(2);
    expect(context.targetTie).toBe(true);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("방해 조건이 켜지면 F_A(S_i)=0 후보 중 V_i 최대 행동을 고른다", () => {
    const context = { joinValueCondition: false, blockingEnabled: true, targetPlayerName: "P1", joinCandidateCount: 0, blockingCandidateCount: 0 };
    const priority = { action: { regionId: null }, targetFuture: 0, value: 1 };
    const highValue = { action: { regionId: "city-0" }, targetFuture: 2, value: 100 };
    const selection = strategy.selectAction([priority, highValue], context, () => 0.5);
    expect(selection.evaluation).toBe(priority);
    expect(context.appliedStage).toBe("방해 전략");
  });

  it("m<Tr이면 M=3/(m_i+1)이고 V=C_i+N_i+F_i+M_i이다", () => {
    const { original, simulated } = valueGames({ selfScore: 4, beforeMeeples: 3, afterMeeples: 2 });
    const evaluation = strategy.evaluateAction(original, { regionId: "city-0", featureType: FEATURE.CITY }, simulated, {
      playerId: 0, targetPlayerId: 1, meeplesAtLeastTurns: false, joinValueCondition: false, targetCity: null,
    });
    expect(evaluation.meepleValue).toBeCloseTo(1);
    expect(evaluation.value).toBeCloseTo(evaluation.immediate + evaluation.future + evaluation.meepleValue);
  });
});

describe("AI 전략 로그와 조언", () => {
  it("모든 AI가 자기 전략 ID·가치 함수·조건·최종 행동·선택 이유를 로그에 남긴다", async () => {
    for (const profile of AI_PROFILES) {
      const game = makePlayableGame(profile.id, () => 0.99);
      const result = await chooseAiAction(game, profile.id);
      expect(result.debug).toMatchObject({
        profileId: profile.id,
        strategyId: profile.strategyId,
        candidateCount: expect.any(Number),
        selectedAction: result.action,
      });
      expect(result.debug.strategyDescription.valueFormula).toMatch(/V_i|G\(x_i\)/);
      expect(result.debug.strategyDescription.mainConditions.length).toBeGreaterThan(0);
      expect(result.debug.selectedReason).toBeTruthy();
      expect(result.evaluation.completed + result.evaluation.incomplete).toBeCloseTo(result.evaluation.immediate);
    }
  });

  it("이수완의 실제 k·확률 판정과 정재이·김규민의 기준 정보가 로그에 포함된다", async () => {
    const lee = await chooseAiAction(makePlayableGame("lee-suwan", () => 0.99), "lee-suwan");
    expect(lee.debug.context).toMatchObject({ k: 7, kAtMostMeeples: true });
    expect(lee.debug.strategyDescription.mainConditions.join(" ")).toContain("k=7");

    const jeong = await chooseAiAction(makePlayableGame("jeong-jaei", () => 0.99), "jeong-jaei");
    expect(jeong.debug.strategyDescription.playerValues).toHaveLength(2);
    expect(jeong.debug.context.targetPlayerName).toBeTruthy();

    const kim = await chooseAiAction(makePlayableGame("kim-gyumin", () => 0.99), "kim-gyumin");
    expect(kim.debug.strategyDescription.opponentFutures).toHaveLength(1);
    kim.debug.evaluations.forEach((evaluation) => expect(evaluation.targetFuture).toBeTypeOf("number"));
  });

  it("AI 조언은 선택한 AI 전략과 같은 형식의 값을 사용하고 원본 상태를 바꾸지 않는다", async () => {
    const game = makePlayableGame("basic", () => 0.4);
    game.players[0].type = "human";
    game.players[0].aiProfileId = null;
    const before = JSON.stringify(game.serializeState());
    const result = await chooseAiAdvice(game, "son-geonhu", { random: () => 0.4 });
    expect(result.debug.strategyId).toBe("son-geonhu");
    expect(result.evaluation.meepleValue).toBeTypeOf("number");
    expect(renderAiStrategyReport(result.debug)).toContain("현재 AI 전략");
    expect(renderAiStrategyReport(result.debug)).toContain("손건후 AI");
    expect(JSON.stringify(game.serializeState())).toBe(before);
  });

  it("조언 기본 난수는 원본 GameEngine의 난수 소스를 소비하지 않는다", async () => {
    const gameRandom = vi.fn(() => 0.6);
    const game = makePlayableGame("basic", gameRandom);
    game.players[0].type = "human";
    gameRandom.mockClear();
    await chooseAiAdvice(game, "lee-suwan");
    expect(gameRandom).not.toHaveBeenCalled();
  });
});
