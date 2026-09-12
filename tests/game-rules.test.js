import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Board } from "../js/board.js";
import { chooseAiAction, evaluateState, generateLegalActions } from "../js/ai.js";
import { FEATURE, PHASE } from "../js/config.js";
import { getLegalMeepleOptions, traceFeature, traceMonastery } from "../js/featureGraph.js";
import { GameEngine } from "../js/game.js";
import { scoreCompletedAround } from "../js/scoring.js";
import { parseTileDefinitions, TileDefinition, TileInstance } from "../js/tile.js";

function definition({ id, edges, city = [], road = [], monastery = false, shield = false }) {
  return new TileDefinition({ id, count: 1, draw_count: 1, edges, city_groups: city, road_groups: road, monastery, shield });
}

describe("타일 회전", () => {
  it("90도 회전하면 북쪽 정보가 동쪽으로 이동하고 네 번 뒤 원상 복구된다", () => {
    const tile = new TileInstance(definition({ id: 1, edges: { 1: "C", 2: "R", 3: "F", 4: "F" }, city: [[1]], road: [[2]] }));
    tile.rotate();
    expect(tile.edgeList).toEqual(["F", "C", "R", "F"]);
    expect(tile.regions.find((region) => region.type === FEATURE.CITY).directions).toEqual([2]);
    tile.rotate(); tile.rotate(); tile.rotate();
    expect(tile.edgeList).toEqual(["C", "R", "F", "F"]);
  });
});

describe("보드 배치", () => {
  it("맞닿는 모든 지형이 같아야 하고 멀리 떨어진 칸은 거부한다", () => {
    const field = definition({ id: 1, edges: { 1: "F", 2: "F", 3: "F", 4: "F" } });
    const westRoad = definition({ id: 2, edges: { 1: "F", 2: "F", 3: "F", 4: "R" }, road: [[4]] });
    const board = new Board();
    board.place(new TileInstance(field), 0, 0);
    expect(board.canPlace(new TileInstance(field), 1, 0)).toBe(true);
    expect(board.canPlace(new TileInstance(westRoad), 1, 0)).toBe(false);
    expect(board.canPlace(new TileInstance(field), 3, 0)).toBe(false);
  });
});

describe("구조물 연결과 점수", () => {
  const leftEnd = definition({ id: 3, edges: { 1: "F", 2: "R", 3: "F", 4: "F" }, road: [[2]] });
  const rightEnd = definition({ id: 4, edges: { 1: "F", 2: "F", 3: "F", 4: "R" }, road: [[4]] });

  it("서로 연결된 두 종점 도로를 하나의 완성 도로로 인식한다", () => {
    const board = new Board();
    board.place(new TileInstance(leftEnd), 0, 0);
    board.place(new TileInstance(rightEnd), 1, 0);
    const road = traceFeature(board, 0, 0, FEATURE.ROAD, "road-0");
    expect(road.complete).toBe(true);
    expect(road.tileKeys.size).toBe(2);
  });

  it("연결 구조물에 다른 미플이 있으면 새 미플을 금지하고 완성 시 점수·회수를 처리한다", () => {
    const board = new Board();
    const left = board.place(new TileInstance(leftEnd), 0, 0);
    left.meeples.push({ playerId: 0, type: FEATURE.ROAD, regionId: "road-0", x: .7, y: .5 });
    const right = board.place(new TileInstance(rightEnd), 1, 0);
    expect(getLegalMeepleOptions(board, 1, 0, 7)).toHaveLength(0);
    const players = [{ id: 0, score: 0, meeples: 6 }, { id: 1, score: 0, meeples: 7 }];
    scoreCompletedAround(board, players, right.x, right.y, new Set());
    expect(players[0].score).toBe(2);
    expect(players[0].meeples).toBe(7);
    expect(left.meeples).toHaveLength(0);
  });
});

describe("수도원", () => {
  it("주변 여덟 칸이 모두 차야 완성된다", () => {
    const monastery = definition({ id: 5, edges: { 1: "F", 2: "F", 3: "F", 4: "F" }, monastery: true });
    const field = definition({ id: 6, edges: { 1: "F", 2: "F", 3: "F", 4: "F" } });
    const board = new Board();
    board.place(new TileInstance(monastery), 0, 0);
    const positions = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y }))).filter(({ x, y }) => x || y);
    positions.slice(0, 7).forEach(({ x, y }) => board.place(new TileInstance(field), x, y));
    expect(traceMonastery(board, 0, 0).complete).toBe(false);
    const last = positions[7];
    board.place(new TileInstance(field), last.x, last.y);
    expect(traceMonastery(board, 0, 0).complete).toBe(true);
  });
});

describe("턴과 전체 덱", () => {
  const tileData = JSON.parse(readFileSync(new URL("../assets/data/tiles.json", import.meta.url), "utf8"));
  const definitions = parseTileDefinitions(tileData);

  it("타일 배치 전에는 미플 행동을 막는다", () => {
    const game = new GameEngine(definitions, { random: () => 0.42 });
    game.startGame([{ name: "A", type: "human" }, { name: "B", type: "human" }]);
    expect(game.phase).toBe(PHASE.ROTATE_OR_PLACE);
    expect(game.toggleMeeple("road-0")).toBe(false);
  });

  it("턴을 마치기 전에는 방금 놓은 타일을 다른 합법 위치로 옮긴다", () => {
    const field = { 1: "F", 2: "F", 3: "F", 4: "F" };
    const start = definition({ id: 1, edges: field });
    const monastery = definition({ id: 2, edges: field, monastery: true });
    const game = new GameEngine([start, monastery], { random: () => 0.99 });
    game.startGame([{ name: "A", type: "human" }, { name: "B", type: "human" }]);

    expect(game.placeCurrentTile(1, 0)).toBe(true);
    expect(game.toggleMeeple("monastery-0")).toBe(true);
    expect(game.currentPlayer.meeples).toBe(6);
    expect(game.getTilePlacementOptions()).toContainEqual({ x: 0, y: 1 });

    expect(game.repositionCurrentTile(0, 1)).toBe(true);
    expect(game.board.has(1, 0)).toBe(false);
    expect(game.board.get(0, 1)).toBe(game.lastPlaced);
    expect(game.previewMeeple).toBeNull();
    expect(game.currentPlayer.meeples).toBe(7);
    expect(game.phase).toBe(PHASE.PLACE_MEEPLE_OR_SKIP);

    expect(game.recallCurrentTile()).toBe(true);
    expect(game.board.has(0, 1)).toBe(false);
    expect(game.currentTile).not.toBeNull();
    expect(game.lastPlaced).toBeNull();
    expect(game.phase).toBe(PHASE.ROTATE_OR_PLACE);
  });

  it("72장 구성의 게임을 끝까지 진행하고 최종 순위를 만든다", () => {
    const game = new GameEngine(definitions, { random: () => 0.37 });
    game.startGame([{ name: "A", type: "human" }, { name: "B", type: "human" }]);
    let guard = 0;
    while (game.phase !== PHASE.GAME_OVER && guard < 300) {
      if (game.phase === PHASE.ROTATE_OR_PLACE) {
        const placement = game.board.getAllLegalPlacements(game.currentTile)[0];
        expect(placement).toBeTruthy();
        game.currentTile.rotation = placement.rotation;
        expect(game.placeCurrentTile(placement.x, placement.y)).toBe(true);
      } else if (game.phase === PHASE.PLACE_MEEPLE_OR_SKIP) game.finishTurn({ skipMeeple: true });
      else if (game.phase === PHASE.SCORE_COMPLETED_FEATURES) game.advanceTurn();
      guard += 1;
    }
    expect(game.phase).toBe(PHASE.GAME_OVER);
    expect(game.board.size + game.discarded.length).toBe(72);
    expect(game.finalRanking).toHaveLength(2);
  });

  it("기본 AI가 모든 합법 행동을 만들고 V(S)=I(S)+F(S)로 하나를 선택한다", async () => {
    const game = new GameEngine(definitions, { random: () => 0.25 });
    game.startGame([{ name: "AI", type: "ai" }, { name: "B", type: "human" }]);
    const actions = generateLegalActions(game);
    expect(actions.length).toBeGreaterThan(0);
    const stateValue = evaluateState(game, 0);
    expect(stateValue.value).toBeCloseTo(stateValue.immediate + stateValue.future);
    const result = await chooseAiAction(game);
    expect(result.action).toBeTruthy();
    expect(actions).toContainEqual(result.action);
  });
});
