import { describe, expect, it, vi } from "vitest";
import { chooseAiAction, chooseAiAdvice, evaluateState, generateLegalActions } from "../js/ai.js";
import { PHASE } from "../js/config.js";
import {
  applyOpponentDraw,
  applySearchAction,
  createOpponentDrawState,
  createSearchSession,
  createSearchStateKey,
  createTileTypeId,
  disposeSearchSession,
  evaluateGameTheoryTurn,
  evaluateGameTheoryTurnBaseline,
  generateSearchLegalActions,
  getPlayableRemainingTiles,
  groupRemainingTilesByType,
  gameTheoryBestResponseStrategy,
  selectReferenceOpponent,
  undoOpponentDraw,
  undoSearchAction,
} from "../js/gameTheoryBestResponse.js";
import { getCachedPlayerValue } from "../js/gameTheorySearchSession.js";
import { GameEngine } from "../js/game.js";
import { TileDefinition, TileInstance } from "../js/tile.js";
import { buildCandidateLogOnDemand, getAiLogPerformance, renderAiStrategyReport } from "../js/ui.js";

function definition({ id, edges = { 1: "F", 2: "F", 3: "F", 4: "F" }, monastery = false }) {
  return new TileDefinition({
    id,
    count: 1,
    draw_count: 1,
    edges,
    city_groups: edges[1] === "C" && edges[2] === "C" && edges[3] === "C" && edges[4] === "C" ? [[1, 2, 3, 4]] : [],
    road_groups: [],
    monastery,
  });
}

const field = definition({ id: 1 });
const monastery = definition({ id: 2, monastery: true });
const allCity = definition({ id: 3, edges: { 1: "C", 2: "C", 3: "C", 4: "C" } });

function makeSearchGame({ scores = [0, 0, 0], deck = [field, field, monastery], current = field } = {}) {
  const game = new GameEngine([field, monastery, allCity], { random: () => 0.5 });
  game.board.place(new TileInstance(field), 0, 0);
  game.players = scores.map((score, id) => ({
    id,
    name: `P${id}`,
    type: id === 0 ? "ai" : "human",
    aiProfileId: id === 0 ? "gameTheoryBestResponse" : null,
    color: "#000",
    score,
    meeples: 7,
  }));
  game.deck = deck.map((item) => new TileInstance(item));
  game.currentPlayerIndex = 0;
  game.currentTile = new TileInstance(current);
  game.phase = PHASE.ROTATE_OR_PLACE;
  return game;
}

describe("??? AI 기준 상대 선택", () => {
  it("자신을 제외하고 V=I+F가 가장 높은 상대만 고른다", () => {
    const result = selectReferenceOpponent(makeSearchGame({ scores: [100, 4, 9] }), 0, () => 0);
    expect(result.target.playerId).toBe(2);
    expect(result.playerValues.find((item) => item.playerId === 0).value).toBe(100);
  });

  it("최고 상대가 동점이면 주입 난수를 정확히 한 번 사용한다", () => {
    const random = vi.fn(() => 0.99);
    const result = selectReferenceOpponent(makeSearchGame({ scores: [0, 8, 8] }), 0, random);
    expect(result.target.playerId).toBe(2);
    expect(result.tied).toBe(true);
    expect(random).toHaveBeenCalledTimes(1);
  });
});

describe("??? AI 합법 행동과 다음 타일 확률", () => {
  it("기존 규칙의 모든 합법 행동을 만들고 불법·대칭 중복은 만들지 않는다", () => {
    const game = makeSearchGame({ current: monastery });
    const actions = generateSearchLegalActions(game);
    expect(actions).toEqual(generateLegalActions(game));
    expect(new Set(actions.map((action) => `${action.x},${action.y}:${action.rotation}:${action.regionId}`)).size).toBe(actions.length);
    actions.forEach((action) => expect(game.simulateAction(action)).toBeTruthy());
  });

  it("배치 가능한 종류만 남기고 물리 수량으로 확률을 계산한다", () => {
    const game = makeSearchGame({ deck: [field, allCity, field, monastery] });
    const playable = getPlayableRemainingTiles(game);
    expect(playable.map(({ tileId, count }) => ({ tileId, count }))).toEqual([
      { tileId: 1, count: 2 },
      { tileId: 2, count: 1 },
    ]);
    expect(playable.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(1);
    expect(playable[0].probability).toBeCloseTo(2 / 3);
  });

  it("같은 물리 타일의 여러 회전을 한 장으로 세고 덱 순서는 해시·확률·선택에 영향을 주지 않는다", async () => {
    const first = makeSearchGame({ deck: [field, monastery, field] });
    const second = makeSearchGame({ deck: [field, field, monastery] });
    expect(getPlayableRemainingTiles(first).map((item) => [item.tileId, item.count, item.probability]))
      .toEqual(getPlayableRemainingTiles(second).map((item) => [item.tileId, item.count, item.probability]));
    expect(createSearchStateKey(first)).toBe(createSearchStateKey(second));
    const firstResult = await chooseAiAction(first, "gameTheoryBestResponse", { random: () => 0.25 });
    const secondResult = await chooseAiAction(second, "gameTheoryBestResponse", { random: () => 0.25 });
    expect(secondResult.action).toEqual(firstResult.action);
    expect(secondResult.debug.evaluations.map((item) => item.value))
      .toEqual(firstResult.debug.evaluations.map((item) => item.value));
  });

  it("배치 가능한 남은 타일이 없으면 T_i가 빈 집합이다", () => {
    expect(getPlayableRemainingTiles(makeSearchGame({ deck: [allCity, allCity] }))).toEqual([]);
  });

  it("규칙이 같은 물리 타일만 묶고, 같은 ID여도 점수·연결 규칙이 다르면 별도 종류로 둔다", () => {
    const plain = definition({ id: 21, edges: { 1: "C", 2: "F", 3: "F", 4: "F" } });
    const shielded = new TileDefinition({
      id: 21,
      count: 1,
      draw_count: 1,
      edges: { 1: "C", 2: "F", 3: "F", 4: "F" },
      city_groups: [[1]],
      road_groups: [],
      shield: true,
    });
    const game = makeSearchGame({ deck: [] });
    game.deck = [new TileInstance(plain), new TileInstance(plain), new TileInstance(shielded)];
    const groups = groupRemainingTilesByType(game);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.count).sort()).toEqual([1, 2]);
    expect(createTileTypeId(plain)).not.toBe(createTileTypeId(shielded));
  });
});

describe("??? AI의 A 최선 대응·기대값·상태 안전성", () => {
  it("A를 즉시 행동 주체로 만들되 중간 플레이어와 실제 상태를 소비하지 않는다", () => {
    const game = makeSearchGame({ scores: [0, 1, 5], deck: [field, monastery] });
    const candidate = game.simulateAction(generateLegalActions(game)[0]);
    const before = JSON.stringify(candidate.serializeState());
    const response = createOpponentDrawState(candidate, 2, 2);
    expect(response.currentPlayer.id).toBe(2);
    expect(response.currentTile.definition.id).toBe(2);
    expect(response.deck).toHaveLength(candidate.deck.length - 1);
    expect(response.players[1]).toEqual(candidate.players[1]);
    expect(JSON.stringify(candidate.serializeState())).toBe(before);
  });

  it("각 타일의 모든 y 중 최대 B_A를 고르고 확률 가중 R_A와 G를 정확히 계산한다", async () => {
    const game = makeSearchGame({ scores: [3, 0, 7], deck: [field, field, monastery] });
    const result = await chooseAiAction(game, "gameTheoryBestResponse", { random: () => 0 });
    const evaluation = result.evaluation;
    const candidate = game.simulateAction(evaluation.action);
    expect(evaluation.tileResponses).toHaveLength(2);

    for (const responseLog of evaluation.tileResponses) {
      const responseBase = createOpponentDrawState(candidate, result.debug.context.targetPlayerId, responseLog.tileId);
      const responseActions = generateSearchLegalActions(responseBase);
      const manualBest = Math.max(...responseActions.map((action) => evaluateState(responseBase.simulateAction(action), 2).value));
      expect(responseLog.responseActionCount).toBe(responseActions.length);
      expect(responseLog.bestValue).toBeCloseTo(manualBest);
    }
    const manualExpected = evaluation.tileResponses.reduce((sum, item) => sum + item.probability * item.bestValue, 0);
    expect(evaluation.expectedResponse).toBeCloseTo(manualExpected);
    expect(evaluation.value).toBeCloseTo(evaluation.selfValue - evaluation.expectedResponse);
    expect(result.debug.evaluations.every((item) => item.value <= evaluation.value + 1e-9)).toBe(true);
  });

  it("T_i가 비면 R_A(S_i)=V_A(S_i)를 적용한다", async () => {
    const game = makeSearchGame({ scores: [1, 5], deck: [allCity] });
    const result = await chooseAiAction(game, "gameTheoryBestResponse", { random: () => 0 });
    const candidate = game.simulateAction(result.evaluation.action);
    expect(result.evaluation.tileResponses).toEqual([]);
    expect(result.evaluation.expectedResponse).toBeCloseTo(evaluateState(candidate, 1).value);
  });

  it("최종 G 최고값이 동점이면 주입 난수로 한 행동을 선택한다", async () => {
    const game = makeSearchGame({ scores: [0, 0], deck: [allCity] });
    const random = vi.fn(() => 0.99);
    const result = await chooseAiAction(game, "gameTheoryBestResponse", { random });
    const bestValue = Math.max(...result.debug.evaluations.map((item) => item.value));
    const ties = result.debug.evaluations.filter((item) => Math.abs(item.value - bestValue) < 1e-9);
    expect(ties.length).toBeGreaterThan(1);
    expect(result.action).toEqual(ties[ties.length - 1].action);
    expect(result.debug.selectedReason).toContain("동점");
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("전체 탐색과 조언은 보드·덱·점수·미플·턴·기록을 변경하지 않고 로그 계산값을 보존한다", async () => {
    const game = makeSearchGame({ scores: [2, 4], deck: [field, monastery] });
    const before = JSON.stringify(game.serializeState());
    const turn = await chooseAiAction(game, "gameTheoryBestResponse", { random: () => 0.25 });
    expect(JSON.stringify(game.serializeState())).toBe(before);
    game.players[0].type = "human";
    game.players[0].aiProfileId = null;
    const adviceBefore = JSON.stringify(game.serializeState());
    const advice = await chooseAiAdvice(game, "gameTheoryBestResponse", { random: () => 0.25 });
    expect(JSON.stringify(game.serializeState())).toBe(adviceBefore);
    expect(advice.evaluation.value).toBeCloseTo(advice.evaluation.selfValue - advice.evaluation.expectedResponse);
    const report = renderAiStrategyReport(turn.debug);
    expect(report).toContain("기준 상대 A");
    expect(report).toContain("P_i(t)");
    expect(report).toContain("G(x_i)");
  });

  it("상태 변경 취소 신호를 받으면 안전하게 탐색을 중단한다", async () => {
    const game = makeSearchGame({ deck: [field, field, monastery] });
    const before = JSON.stringify(game.serializeState());
    const result = await chooseAiAction(game, "gameTheoryBestResponse", { shouldCancel: () => true });
    expect(result.cancelled).toBe(true);
    expect(result.action).toBeNull();
    expect(JSON.stringify(game.serializeState())).toBe(before);
  });

  it("x, 가상 타일 t, 상대 행동 y를 중첩 적용해도 역순 복원 시 바이트 수준 상태가 돌아온다", () => {
    const game = makeSearchGame({ scores: [2, 4], deck: [field, field, monastery] });
    const session = createSearchSession(game, { verifyRestoration: true });
    const state = session.rootState;
    const rootBefore = JSON.stringify(state.serializeState());
    const x = generateSearchLegalActions(state)[0];
    const xPatch = applySearchAction(session, state, x);
    const candidateBefore = JSON.stringify(state.serializeState());
    const tileGroup = getPlayableRemainingTiles(state)[0];
    const drawPatch = applyOpponentDraw(session, state, 1, tileGroup.tileTypeId);
    const drawBefore = JSON.stringify(state.serializeState());
    const y = generateSearchLegalActions(state)[0];
    const yPatch = applySearchAction(session, state, y);
    undoSearchAction(session, state, yPatch);
    expect(JSON.stringify(state.serializeState())).toBe(drawBefore);
    undoOpponentDraw(session, state, drawPatch);
    expect(JSON.stringify(state.serializeState())).toBe(candidateBefore);
    undoSearchAction(session, state, xPatch);
    expect(JSON.stringify(state.serializeState())).toBe(rootBefore);
    disposeSearchSession(session);
  });

  it("계산 중 예외가 나도 finally에서 패치 스택과 탐색 상태를 완전히 복원한다", async () => {
    const game = makeSearchGame({ deck: [field, monastery] });
    const session = createSearchSession(game, { verifyRestoration: true });
    const context = gameTheoryBestResponseStrategy.prepareTurnContext(game, 0, () => 0, session);
    const actions = generateSearchLegalActions(session.rootState);
    const before = JSON.stringify(session.rootState.serializeState());
    const failure = vi.spyOn(session.rootState.board, "getAllLegalPlacements")
      .mockImplementation(() => { throw new Error("의도한 계산 실패"); });
    await expect(evaluateGameTheoryTurn(game, actions, context, { searchSession: session }))
      .rejects.toThrow("의도한 계산 실패");
    failure.mockRestore();
    expect(session.patchStack).toHaveLength(0);
    expect(JSON.stringify(session.rootState.serializeState())).toBe(before);
    disposeSearchSession(session);
  });

  it("세션 캐시는 같은 상태의 V/F를 재사용하고 평가 대상별 키를 분리한다", () => {
    const game = makeSearchGame({ scores: [1, 5, 7] });
    const session = createSearchSession(game);
    const first = getCachedPlayerValue(session, session.rootState, 1);
    const second = getCachedPlayerValue(session, session.rootState, 1);
    const other = getCachedPlayerValue(session, session.rootState, 2);
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.featureDetails)).toBe(true);
    expect(other.value).not.toBe(first.value);
    expect(session.performanceCounters.cacheStats.stateValue).toMatchObject({ hits: 1, misses: 2 });
    expect(session.performanceCounters.stateValueCalculationCount).toBe(2);
    disposeSearchSession(session);
    expect(session.disposed).toBe(true);
    expect(session.rootState).toBeNull();
    expect(session.stateValueCache.size).toBe(0);
  });

  it("서로 다른 상태는 같은 V 캐시 항목을 공유하지 않는다", () => {
    const game = makeSearchGame({ scores: [1, 5] });
    const session = createSearchSession(game);
    getCachedPlayerValue(session, session.rootState, 0);
    const calculationsBefore = session.performanceCounters.stateValueCalculationCount;
    const patch = applySearchAction(session, session.rootState, generateSearchLegalActions(session.rootState)[0]);
    getCachedPlayerValue(session, session.rootState, 0);
    expect(session.performanceCounters.stateValueCalculationCount).toBe(calculationsBefore + 1);
    undoSearchAction(session, session.rootState, patch);
    disposeSearchSession(session);
  });

  it("최적화 전 기준 구현과 A, 모든 B/R/G, 동점 목록과 최종 행동이 같다", async () => {
    const game = makeSearchGame({ scores: [3, 0, 7], deck: [field, field, monastery] });
    const actions = generateSearchLegalActions(game);
    const makeContext = () => gameTheoryBestResponseStrategy.prepareTurnContext(game, 0, () => 0);
    const baselineContext = makeContext();
    const optimizedContext = makeContext();
    const baseline = await evaluateGameTheoryTurnBaseline(game, actions, baselineContext, {
      random: () => 0,
      yieldEvery: Number.MAX_SAFE_INTEGER,
    });
    const optimized = await evaluateGameTheoryTurn(game, actions, optimizedContext, {
      random: () => 0,
      yieldEvery: Number.MAX_SAFE_INTEGER,
      verifyRestoration: true,
    });
    expect(optimizedContext.targetPlayerId).toBe(baselineContext.targetPlayerId);
    expect(optimized.evaluations.map((item) => item.action)).toEqual(baseline.evaluations.map((item) => item.action));
    optimized.evaluations.forEach((item, index) => {
      const reference = baseline.evaluations[index];
      expect(item.selfValue).toBeCloseTo(reference.selfValue, 12);
      expect(item.expectedResponse).toBeCloseTo(reference.expectedResponse, 12);
      expect(item.value).toBeCloseTo(reference.value, 12);
      expect(item.tileResponses.map((response) => ({
        tileTypeId: response.tileTypeId,
        count: response.count,
        probability: response.probability,
        bestAction: response.bestAction,
      }))).toEqual(reference.tileResponses.map((response) => ({
        tileTypeId: response.tileTypeId,
        count: response.count,
        probability: response.probability,
        bestAction: response.bestAction,
      })));
      expect(item.tileResponses.map((response) => response.bestValue))
        .toEqual(reference.tileResponses.map((response) => response.bestValue));
    });
    const best = (items) => {
      const maximum = Math.max(...items.map((item) => item.value));
      return items.filter((item) => Math.abs(item.value - maximum) < 1e-9).map((item) => item.action);
    };
    expect(best(optimized.evaluations)).toEqual(best(baseline.evaluations));
    expect(optimized.selection.evaluation.action).toEqual(baseline.selection.evaluation.action);
    expect(optimizedContext.performanceCounters.fullStateCloneCount).toBe(1);
    expect(baselineContext.performanceCounters.fullStateCloneCount).toBeGreaterThan(1);
  });

  it("상세 로그는 저장 결과만 지연 렌더링하며 V/F나 난수를 다시 호출하지 않는다", async () => {
    const random = vi.fn(() => 0);
    const game = makeSearchGame({ scores: [2, 4], deck: [field, monastery] });
    const before = JSON.stringify(game.serializeState());
    const turn = await chooseAiAction(game, "gameTheoryBestResponse", { random });
    expect(JSON.stringify(game.serializeState())).toBe(before);
    game.aiDebug = turn.debug;
    const stateWithLog = JSON.stringify(game.serializeState());
    const counters = turn.debug.context.performanceCounters;
    const valuesBefore = [counters.stateValueCalculationCount, counters.futureValueCalculationCount];
    const randomCallsBefore = random.mock.calls.length;
    const report = renderAiStrategyReport(turn.debug);
    expect(report).toContain("펼치세요");
    const detail = buildCandidateLogOnDemand(turn.debug, 0);
    expect(detail).toContain("P_i(t)");
    expect(detail).toContain("B_A");
    expect(getAiLogPerformance(turn.debug)).toMatchObject({ renderCount: 1, detailedBuildCount: 1 });
    expect([counters.stateValueCalculationCount, counters.futureValueCalculationCount]).toEqual(valuesBefore);
    expect(random).toHaveBeenCalledTimes(randomCallsBefore);
    expect(JSON.stringify(game.serializeState())).toBe(stateWithLog);
  });

  it("탐색 진행 중에는 후보 상세 로그와 응답 표를 만들지 않는다", async () => {
    const snapshots = [];
    const result = await chooseAiAction(
      makeSearchGame({ deck: [field, field, monastery] }),
      "gameTheoryBestResponse",
      {
        random: () => 0,
        onPrepared: (debug) => snapshots.push(debug),
        onProgress: (debug) => snapshots.push(debug),
      },
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((debug) => debug.evaluations.length === 0)).toBe(true);
    expect(snapshots.every((debug) => !renderAiStrategyReport(debug).includes("response-table"))).toBe(true);
    expect(result.debug.evaluations.length).toBeGreaterThan(0);
    expect(renderAiStrategyReport(result.debug)).not.toContain("response-table");
    expect(buildCandidateLogOnDemand(result.debug, 0)).toContain("response-table");
  });
});
