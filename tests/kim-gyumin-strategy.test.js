import { describe, expect, it, vi } from "vitest";
import { Board } from "../js/board.js";
import { chooseAiAction, chooseAiAdvice, generateLegalActions } from "../js/ai.js";
import { FEATURE, PHASE } from "../js/config.js";
import { GameEngine } from "../js/game.js";
import {
  BASE_JOIN_PATTERNS,
  JOIN_PATTERNS,
  cityShapeForTile,
  evaluateKimAction,
  findJoinableCities,
  generateJoinPatterns,
  kimGyuminStrategy,
  matchesJoinPattern,
  rotatePattern90,
  rotatePosition90,
  rotateShape90,
  selectBlockingOpponent,
  selectTargetCity,
} from "../js/kimGyuminStrategy.js";
import { TileDefinition, TileInstance } from "../js/tile.js";
import { renderAiStrategyReport } from "../js/ui.js";

function definition({ id, edges, city = [], road = [], shield = false, monastery = false }) {
  return new TileDefinition({
    id,
    count: 1,
    draw_count: 1,
    edges,
    city_groups: city,
    road_groups: road,
    shield,
    monastery,
  });
}

const fieldEdges = { 1: "F", 2: "F", 3: "F", 4: "F" };
const field = definition({ id: 1, edges: fieldEdges });
const northCity = definition({ id: 2, edges: { 1: "C", 2: "F", 3: "F", 4: "F" }, city: [[1]] });
const eastCity = definition({ id: 3, edges: { 1: "F", 2: "C", 3: "F", 4: "F" }, city: [[2]] });
const southCity = definition({ id: 4, edges: { 1: "F", 2: "F", 3: "C", 4: "F" }, city: [[3]] });
const westCity = definition({ id: 5, edges: { 1: "F", 2: "F", 3: "F", 4: "C" }, city: [[4]] });
const northEastCity = definition({ id: 6, edges: { 1: "C", 2: "C", 3: "F", 4: "F" }, city: [[1, 2]] });
const shieldNorthCity = definition({ id: 7, edges: { 1: "C", 2: "F", 3: "F", 4: "F" }, city: [[1]], shield: true });
const eastRoad = definition({ id: 8, edges: { 1: "F", 2: "R", 3: "F", 4: "F" }, road: [[2]] });
const monastery = definition({ id: 9, edges: fieldEdges, monastery: true });
const allCity = definition({ id: 11, edges: { 1: "C", 2: "C", 3: "C", 4: "C" }, city: [[1, 2, 3, 4]] });
const definitions = [field, northCity, eastCity, southCity, westCity, northEastCity, shieldNorthCity, eastRoad, monastery, allCity];

function player(id, { score = 0, meeples = 7, type = "human" } = {}) {
  return { id, name: `P${id}`, type, aiProfileId: type === "ai" ? "kim-gyumin" : null, color: "#000", score, meeples };
}

function manualGame({ board = new Board(), players = [player(0, { type: "ai" }), player(1)], deck = [], currentTile = field } = {}) {
  const game = new GameEngine(definitions, { random: () => 0.5 });
  game.board = board;
  game.players = players;
  game.deck = deck.map((tile) => new TileInstance(tile));
  game.currentPlayerIndex = 0;
  game.currentTile = currentTile ? new TileInstance(currentTile) : null;
  game.phase = PHASE.ROTATE_OR_PLACE;
  return game;
}

function meeple(playerId, regionId = "city-0") {
  return { playerId, type: FEATURE.CITY, regionId, x: 0.5, y: 0.2 };
}

function valueState({ score = 0, meeples = 7 } = {}) {
  return manualGame({ players: [player(0, { score, meeples, type: "ai" }), player(1)] });
}

describe("김규민 후보 가치", () => {
  it("C_i는 누적 점수가 아니라 score_self(S_i)-score_self(S)이고 I_i=C_i+N_i이다", () => {
    const original = valueState({ score: 10, meeples: 4 });
    const simulated = valueState({ score: 13, meeples: 4 });
    const evaluation = evaluateKimAction(original, { x: 1, y: 0, rotation: 0, regionId: null }, simulated, {
      playerId: 0, targetPlayerId: 1, meeplesAtLeastTurns: true, joinValueCondition: false, targetCity: null,
    });
    expect(evaluation.cumulativeCompleted).toBe(13);
    expect(evaluation.completed).toBe(3);
    expect(evaluation.immediate).toBe(evaluation.completed + evaluation.incomplete);
  });

  it("m>=Tr이면 미플 유무와 관계없이 M_i=0이다", () => {
    const original = valueState({ meeples: 4 });
    for (const [regionId, after] of [[null, 4], ["city-0", 3]]) {
      const evaluation = evaluateKimAction(original, { x: 1, y: 0, rotation: 0, regionId, featureType: FEATURE.CITY }, valueState({ meeples: after }), {
        playerId: 0, targetPlayerId: 1, meeplesAtLeastTurns: true, joinValueCondition: false, targetCity: null,
      });
      expect(evaluation.meepleValue).toBe(0);
    }
  });

  it("m<Tr이면 회수까지 끝난 m_i로 M_i=3/(m_i+1), V_i=C_i+N_i+F_i+M_i를 계산한다", () => {
    const original = valueState({ score: 5, meeples: 2 });
    const recovered = valueState({ score: 7, meeples: 3 });
    const evaluation = evaluateKimAction(original, { x: 1, y: 0, rotation: 0, regionId: "city-0", featureType: FEATURE.CITY }, recovered, {
      playerId: 0, targetPlayerId: 1, meeplesAtLeastTurns: false, joinValueCondition: false, targetCity: null,
    });
    expect(evaluation.meeplesAfter).toBe(3);
    expect(evaluation.meepleValue).toBeCloseTo(3 / 4);
    expect(evaluation.value).toBeCloseTo(evaluation.completed + evaluation.incomplete + evaluation.future + evaluation.meepleValue);
  });

  it("실제 완성 행동에서 배치한 미플이 즉시 회수되면 회수 후 m_i를 사용한다", () => {
    const board = new Board();
    board.place(new TileInstance(eastCity), 0, 0);
    const game = manualGame({ board, players: [player(0, { meeples: 2, type: "ai" }), player(1)], deck: [field, field], currentTile: westCity });
    const action = generateLegalActions(game).find((candidate) => candidate.x === 1 && candidate.y === 0
      && candidate.rotation === 0 && candidate.featureType === FEATURE.CITY);
    const simulated = game.simulateAction(action);
    expect(simulated.players[0].meeples).toBe(2);
    const evaluation = evaluateKimAction(game, action, simulated, {
      playerId: 0, targetPlayerId: 1, meeplesAtLeastTurns: false, joinValueCondition: false, targetCity: null,
    });
    expect(evaluation.meeplesAfter).toBe(2);
    expect(evaluation.meepleValue).toBeCloseTo(1);
  });
});

describe("꼽사리 후보 성과 대상 선택", () => {
  it("상대 미플이 없거나 q_self>q_opp^max인 성은 제외하고 q_self<=q_opp^max만 포함한다", () => {
    const board = new Board();
    const noOpponent = board.place(new TileInstance(northCity), 0, 0);
    noOpponent.meeples.push(meeple(0));
    const selfAhead = board.place(new TileInstance(northCity), 3, 0);
    selfAhead.meeples.push(meeple(0), meeple(0), meeple(1));
    const joinable = board.place(new TileInstance(northCity), 6, 0);
    joinable.meeples.push(meeple(0), meeple(1));
    const cities = findJoinableCities(manualGame({ board, players: [player(0), player(1), player(2)], deck: [southCity] }), 0);
    expect(cities).toHaveLength(1);
    expect(cities[0]).toMatchObject({ selfMeeples: 1, maxOpponentMeeples: 1 });
    expect(cities[0].tileCoordinates).toContainEqual({ x: 6, y: 0 });
  });

  it("F_c가 가장 높은 성을 고르고 최고값 동점은 주입 난수를 한 번 사용한다", () => {
    const low = { key: "low", future: 1 };
    const high = { key: "high", future: 2 };
    expect(selectTargetCity([low, high], () => 0).target).toBe(high);
    const random = vi.fn(() => 0.99);
    const tied = selectTargetCity([{ key: "a", future: 2 }, { key: "b", future: 2 }], random);
    expect(tied.target.key).toBe("b");
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("실제 성 미래가치는 기존 완성 확률과 점수 함수를 사용하며 방패 성이 더 높다", () => {
    const board = new Board();
    const plainPlaced = board.place(new TileInstance(northCity), 0, 0);
    plainPlaced.meeples.push(meeple(1));
    const shieldPlaced = board.place(new TileInstance(shieldNorthCity), 4, 0);
    shieldPlaced.meeples.push(meeple(1));
    const game = manualGame({ board, deck: [southCity] });
    const cities = findJoinableCities(game, 0);
    const plain = cities.find((city) => city.tileCoordinates[0].x === 0);
    const shield = cities.find((city) => city.tileCoordinates[0].x === 4);
    expect(shield.future).toBeGreaterThan(plain.future);
  });
});

describe("꼽사리 패턴과 프로젝트 좌표계", () => {
  it("P_0 8개를 보존하고 네 방향 회전 후 중복 패턴을 제거한다", () => {
    expect(BASE_JOIN_PATTERNS).toHaveLength(8);
    expect(BASE_JOIN_PATTERNS).toEqual([
      { dx: 1, dy: 1, targetShape: "C###", actionShape: "###C" },
      { dx: 1, dy: 1, targetShape: "#C##", actionShape: "##C#" },
      { dx: 2, dy: 0, targetShape: "#C##", actionShape: "###C" },
      { dx: 0, dy: 2, targetShape: "C###", actionShape: "##C#" },
      { dx: 1, dy: 0, targetShape: "C###", actionShape: "C###" },
      { dx: 1, dy: 0, targetShape: "#C##", actionShape: "#C##" },
      { dx: 0, dy: 1, targetShape: "##C#", actionShape: "##C#" },
      { dx: 0, dy: 1, targetShape: "###C", actionShape: "###C" },
    ]);
    expect(JOIN_PATTERNS).toHaveLength(28);
    const keys = new Set(JOIN_PATTERNS.map((pattern) => `${pattern.dx},${pattern.dy}:${pattern.targetShape}:${pattern.actionShape}`));
    expect(keys.size).toBe(JOIN_PATTERNS.length);
    for (const base of BASE_JOIN_PATTERNS) {
      let pattern = { ...base, dy: -base.dy };
      for (let rotation = 0; rotation < 4; rotation += 1) {
        expect(keys.has(`${pattern.dx},${pattern.dy}:${pattern.targetShape}:${pattern.actionShape}`)).toBe(true);
        pattern = rotatePattern90(pattern);
      }
    }
    expect(generateJoinPatterns()).toEqual(JOIN_PATTERNS);
  });

  it("+y가 위인 프로젝트에서 좌표와 T_1,T_2를 시계 방향으로 함께 회전한다", () => {
    expect(rotatePosition90(1, -1)).toEqual({ dx: -1, dy: -1 });
    expect(rotateShape90("C###")).toBe("#C##");
    expect(rotatePattern90({ dx: 1, dy: -1, targetShape: "C###", actionShape: "###C" }))
      .toEqual({ dx: -1, dy: -1, targetShape: "#C##", actionShape: "C###" });
  });

  it("#은 와일드카드가 아니라 정확히 성이 아닌 변이며 회전 적용 형태를 사용한다", () => {
    expect(cityShapeForTile(new TileInstance(eastRoad))).toBe("####");
    expect(cityShapeForTile(new TileInstance(northCity))).toBe("C###");
    expect(cityShapeForTile(new TileInstance(northCity), 1)).toBe("#C##");
    const exactBoard = new Board();
    exactBoard.place(new TileInstance(northCity), 0, 0);
    const exactGame = manualGame({ board: exactBoard, currentTile: northCity });
    const target = { nodes: [{ x: 0, y: 0, regionId: "city-0" }] };
    expect(matchesJoinPattern(exactGame, { x: 1, y: 0, rotation: 0, regionId: "city-0", featureType: FEATURE.CITY }, target).matched).toBe(true);

    const extraCityBoard = new Board();
    extraCityBoard.place(new TileInstance(northEastCity), 0, 0);
    const extraCityGame = manualGame({ board: extraCityBoard, currentTile: northCity });
    expect(matchesJoinPattern(extraCityGame, { x: 1, y: 0, rotation: 0, regionId: "city-0", featureType: FEATURE.CITY }, target).matched).toBe(false);
  });

  it("부호 있는 dx,dy를 구별하고 대상 성의 모든 관련 타일을 검사한다", () => {
    const board = new Board();
    board.place(new TileInstance(northEastCity), -5, -5);
    board.place(new TileInstance(northCity), 0, 0);
    const game = manualGame({ board, currentTile: westCity });
    const target = { nodes: [{ x: -5, y: -5, regionId: "city-0" }, { x: 0, y: 0, regionId: "city-0" }] };
    const positive = matchesJoinPattern(game, { x: 1, y: -1, rotation: 0, regionId: "city-0", featureType: FEATURE.CITY }, target);
    const negative = matchesJoinPattern(game, { x: -1, y: 1, rotation: 0, regionId: "city-0", featureType: FEATURE.CITY }, target);
    expect(positive.matched).toBe(true);
    expect(positive.detail).toMatchObject({ targetX: 0, targetY: 0, dx: 1, dy: -1 });
    expect(negative.matched).toBe(false);
  });

  it("미플 미배치·도로·수도원 행동은 패턴과 무관하게 제외한다", () => {
    const board = new Board();
    board.place(new TileInstance(northCity), 0, 0);
    const game = manualGame({ board, currentTile: northCity });
    const target = { nodes: [{ x: 0, y: 0, regionId: "city-0" }] };
    expect(matchesJoinPattern(game, { x: 1, y: 0, rotation: 0, regionId: null }, target).matched).toBe(false);
    expect(matchesJoinPattern(game, { x: 1, y: 0, rotation: 0, regionId: "road-0", featureType: FEATURE.ROAD }, target).matched).toBe(false);
    expect(matchesJoinPattern(game, { x: 1, y: 0, rotation: 0, regionId: "monastery-0", featureType: FEATURE.MONASTERY }, target).matched).toBe(false);
  });
});

function joinScenario() {
  const board = new Board();
  const target = board.place(new TileInstance(northCity), 0, 0);
  target.meeples.push(meeple(1));
  return manualGame({ board, players: [player(0, { type: "ai" }), player(1)], deck: [southCity], currentTile: northCity });
}

describe("꼽사리·방해·일반 선택 순서", () => {
  it("기존 합법 행동 중 성 미플·패턴·F_cH 유지 조건을 모두 만족한 행동을 꼽사리로 인정한다", () => {
    const game = joinScenario();
    const context = kimGyuminStrategy.prepareTurnContext(game, 0, () => 0);
    const action = generateLegalActions(game).find((candidate) => candidate.x === 1 && candidate.y === 0
      && candidate.rotation === 0 && candidate.featureType === FEATURE.CITY);
    expect(action).toBeTruthy();
    const evaluation = kimGyuminStrategy.evaluateAction(game, action, game.simulateAction(action), context);
    expect(context.joinValueCondition).toBe(true);
    expect(evaluation.patternMatched).toBe(true);
    expect(evaluation.targetCityFutureMaintained).toBe(true);
    expect(evaluation.joinEligible).toBe(true);
  });

  it("F_cH(S_i)가 변하면 패턴이 맞아도 꼽사리 후보에서 제외한다", () => {
    const board = new Board();
    const target = board.place(new TileInstance(northCity), 0, 0);
    target.meeples.push(meeple(1));
    board.place(new TileInstance(field), 1, 0);
    const game = manualGame({ board, players: [player(0, { type: "ai" }), player(1)], deck: [allCity], currentTile: eastCity });
    const context = kimGyuminStrategy.prepareTurnContext(game, 0, () => 0);
    const action = generateLegalActions(game).find((candidate) => candidate.x === 1 && candidate.y === 1
      && candidate.rotation === 0 && candidate.featureType === FEATURE.CITY);
    expect(action).toBeTruthy();
    const evaluation = kimGyuminStrategy.evaluateAction(game, action, game.simulateAction(action), context);
    expect(evaluation.patternMatched).toBe(true);
    expect(evaluation.targetCityFutureAfter).toBe(0);
    expect(evaluation.targetCityFutureMaintained).toBe(false);
    expect(evaluation.joinEligible).toBe(false);
  });

  it("꼽사리 후보가 있으면 방해 후보보다 먼저 적용하고 그 안에서 V_i 최대를 고른다", () => {
    const lowJoin = { action: { x: 0 }, joinEligible: true, targetFuture: 5, value: 4 };
    const highJoin = { action: { x: 1 }, joinEligible: true, targetFuture: 5, value: 8 };
    const blocking = { action: { x: 2 }, joinEligible: false, targetFuture: 0, value: 100 };
    const context = { joinValueCondition: true, blockingEnabled: true, targetPlayerName: "P1", joinCandidateCount: 0, blockingCandidateCount: 0 };
    const selected = kimGyuminStrategy.selectAction([lowJoin, highJoin, blocking], context, () => 0);
    expect(selected.evaluation).toBe(highJoin);
    expect(context.appliedStage).toBe("꼽사리 전략");
  });

  it("꼽사리가 없으면 고정 A의 F_A(S_i)=0 후보 중 V_i 최대를 선택한다", () => {
    const low = { action: { x: 0 }, joinEligible: false, targetFuture: 0, value: 3 };
    const high = { action: { x: 1 }, joinEligible: false, targetFuture: 0, value: 9 };
    const other = { action: { x: 2 }, joinEligible: false, targetFuture: 4, value: 100 };
    const context = { joinValueCondition: false, blockingEnabled: true, targetPlayerName: "P1", joinCandidateCount: 0, blockingCandidateCount: 0 };
    const selected = kimGyuminStrategy.selectAction([low, high, other], context, () => 0);
    expect(selected.evaluation).toBe(high);
    expect(context.appliedStage).toBe("방해 전략");
  });

  it("꼽사리와 방해가 없으면 일반 V_i 최대, 동점이면 주입 난수로 선택한다", () => {
    const first = { action: { x: 0 }, joinEligible: false, targetFuture: 2, value: 9 };
    const second = { action: { x: 1 }, joinEligible: false, targetFuture: 2, value: 9 };
    const random = vi.fn(() => 0.99);
    const context = { joinValueCondition: false, blockingEnabled: false, joinCandidateCount: 0, blockingCandidateCount: 0 };
    const selected = kimGyuminStrategy.selectAction([first, second], context, random);
    expect(selected.evaluation).toBe(second);
    expect(context.appliedStage).toBe("일반 상태 평가");
    expect(random).toHaveBeenCalledTimes(1);
  });
});

describe("방해 상대 고정·난수·상태 안전성과 로그", () => {
  it("자신을 제외한 F 최고 상대를 A로 고르고 동점이면 난수를 한 번만 사용한다", () => {
    const game = manualGame({ players: [player(0), player(1), player(2)] });
    const random = vi.fn(() => 0.99);
    const result = selectBlockingOpponent(game, 0, random);
    expect(result.opponentFutures.map((item) => item.playerId)).toEqual([1, 2]);
    expect(result.target.playerId).toBe(2);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("서로 다른 F라면 가장 높은 상대를 A로 고른다", () => {
    const board = new Board();
    const plain = board.place(new TileInstance(northCity), 0, 0);
    plain.meeples.push(meeple(1));
    const shield = board.place(new TileInstance(shieldNorthCity), 4, 0);
    shield.meeples.push(meeple(2));
    const game = manualGame({ board, players: [player(0), player(1), player(2)], deck: [southCity] });
    const result = selectBlockingOpponent(game, 0, () => 0);
    expect(result.target.playerId).toBe(2);
    expect(result.opponentFutures.find((item) => item.playerId === 2).future)
      .toBeGreaterThan(result.opponentFutures.find((item) => item.playerId === 1).future);
  });

  it("후보 상태에서 다른 상대 F가 더 높아져도 턴 시작에 고정한 A만 계산한다", () => {
    const original = valueState();
    const board = new Board();
    const city = board.place(new TileInstance(northCity), 0, 0);
    city.meeples.push(meeple(2));
    const simulated = manualGame({ board, players: [player(0), player(1), player(2)], deck: [southCity] });
    const evaluation = evaluateKimAction(original, { x: 2, y: 0, rotation: 0, regionId: null }, simulated, {
      playerId: 0, targetPlayerId: 1, meeplesAtLeastTurns: true, joinValueCondition: false, targetCity: null,
    });
    expect(evaluation.targetFuture).toBe(0);
    expect(selectBlockingOpponent(simulated, 0, () => 0).target.playerId).toBe(2);
    const selectionContext = { joinValueCondition: false, blockingEnabled: true, targetPlayerName: "P1", joinCandidateCount: 0, blockingCandidateCount: 0 };
    expect(kimGyuminStrategy.selectAction([evaluation], selectionContext, () => 0).evaluation).toBe(evaluation);
    expect(selectionContext.appliedStage).toBe("방해 전략");
  });

  it("prepareTurnContext에서 동점 c_H를 한 번만 정하고 후보 평가에서 다시 뽑지 않는다", () => {
    const board = new Board();
    const first = board.place(new TileInstance(northCity), 0, 0);
    first.meeples.push(meeple(1));
    const second = board.place(new TileInstance(northCity), 4, 0);
    second.meeples.push(meeple(1));
    const game = manualGame({ board, players: [player(0, { type: "ai" }), player(1)], deck: [southCity], currentTile: northCity });
    const random = vi.fn(() => 0.25);
    const context = kimGyuminStrategy.prepareTurnContext(game, 0, random);
    const callsAfterPrepare = random.mock.calls.length;
    const action = generateLegalActions(game)[0];
    kimGyuminStrategy.evaluateAction(game, action, game.simulateAction(action), context);
    kimGyuminStrategy.evaluateAction(game, action, game.simulateAction(action), context);
    expect(random).toHaveBeenCalledTimes(callsAfterPrepare);
    expect(callsAfterPrepare).toBe(1);
    expect(context.targetCityKey).toBeTruthy();
  });

  it("후보 평가와 AI 조언 전후 실제 상태·기록이 같고 로그 값이 계산값과 일치한다", async () => {
    const game = joinScenario();
    const before = JSON.stringify(game.serializeState());
    const turn = await chooseAiAction(game, "kim-gyumin", { random: () => 0 });
    expect(JSON.stringify(game.serializeState())).toBe(before);
    expect(turn.evaluation.value).toBeCloseTo(turn.evaluation.completed + turn.evaluation.incomplete
      + turn.evaluation.future + turn.evaluation.meepleValue);
    expect(turn.debug.context.appliedStage).toBeTruthy();
    const report = renderAiStrategyReport(turn.debug);
    expect(report).toContain("꼽사리 전략");
    expect(report).toContain("F_A(S_i)");
    expect(report).toContain("q_opp^max");

    game.players[0].type = "human";
    game.players[0].aiProfileId = null;
    const adviceBefore = JSON.stringify(game.serializeState());
    const advice = await chooseAiAdvice(game, "kim-gyumin", { random: () => 0 });
    expect(advice.action).toBeTruthy();
    expect(JSON.stringify(game.serializeState())).toBe(adviceBefore);
    expect(advice.debug.strategyDescription.appliedStage).toBe(advice.debug.context.appliedStage);
  });
});
