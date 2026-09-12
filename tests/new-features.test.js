import { describe, expect, it } from "vitest";
import { createActionPreview } from "../js/actionPreview.js";
import { chooseAiAdvice, resolveAiStrategy } from "../js/ai.js";
import { AI_PROFILES } from "../js/aiProfiles.js";
import { canRunAiTurn } from "../js/aiTurnPolicy.js";
import { AI_TURN_MODE, FEATURE, PHASE } from "../js/config.js";
import { GameEngine } from "../js/game.js";
import { TileDefinition } from "../js/tile.js";
import { showSetupScreen } from "../js/ui.js";

function definition({ id, count = 1, monastery = false }) {
  return new TileDefinition({
    id,
    count,
    draw_count: count,
    edges: { 1: "F", 2: "F", 3: "F", 4: "F" },
    city_groups: [],
    road_groups: [],
    monastery,
  });
}

function makeGame(firstType = "human", options = {}) {
  const game = new GameEngine([
    definition({ id: 1 }),
    definition({ id: 2, count: 2, monastery: true }),
  ], { random: () => 0.99 });
  const first = firstType === "ai"
    ? { name: "기본 AI", type: "ai", aiProfileId: "basic" }
    : { name: "사람", type: "human" };
  game.startGame([first, { name: "상대", type: "human" }], options);
  return game;
}

function completeTurn(game, x, y) {
  expect(game.placeCurrentTile(x, y)).toBe(true);
  game.finishTurn({ skipMeeple: true });
  expect(game.advanceTurn()).toBe(true);
}

describe("AI 프로필과 독립 전략", () => {
  it("9개 AI 프로필을 모두 플레이어로 선택할 수 있다", () => {
    expect(AI_PROFILES.map((profile) => profile.name)).toEqual([
      "기본 AI", "허서연 AI", "이수완 AI", "정재이 AI",
      "손건후 AI", "김규민 AI", "장성이 AI", "소규원 AI", "??? AI",
    ]);
    for (const profile of AI_PROFILES) {
      const game = new GameEngine([definition({ id: 1 }), definition({ id: 2 })], { random: () => 0.99 });
      game.startGame([
        { type: "ai", aiProfileId: profile.id },
        { name: "사람", type: "human" },
      ]);
      expect(game.currentPlayer.aiProfileId).toBe(profile.id);
      expect(game.currentPlayer.name).toBe(profile.name);
    }
  });

  it("9개 AI가 나중에 따로 수정할 수 있는 독립 전략 ID와 객체를 사용한다", () => {
    const strategies = AI_PROFILES.map((profile) => resolveAiStrategy(profile.id));
    expect(new Set(strategies).size).toBe(9);
    expect(new Set(AI_PROFILES.map((profile) => profile.strategyId)).size).toBe(9);
    AI_PROFILES.forEach((profile, index) => expect(strategies[index].id).toBe(profile.strategyId));
  });
});

describe("읽기 전용 AI 조언과 로그 좌표", () => {
  it("타일 배치 전과 미플 단계 조언이 실제 게임 상태를 바꾸지 않는다", async () => {
    const game = makeGame();
    const beforePlacementAdvice = JSON.stringify(game.serializeState());
    const placementAdvice = await chooseAiAdvice(game, "heo-seoyeon");
    expect(placementAdvice.action).toBeTruthy();
    expect(JSON.stringify(game.serializeState())).toBe(beforePlacementAdvice);

    expect(game.placeCurrentTile(1, 0)).toBe(true);
    expect(game.toggleMeeple("monastery-0")).toBe(true);
    const beforeMeepleAdvice = JSON.stringify(game.serializeState());
    const meepleAdvice = await chooseAiAdvice(game, "lee-suwan");
    expect(meepleAdvice.action).toMatchObject({ x: 1, y: 0, rotation: 0 });
    expect(JSON.stringify(game.serializeState())).toBe(beforeMeepleAdvice);
  });

  it("AI 로그 행동을 같은 좌표·회전·미플 정보의 보드 미리보기로 바꾼다", () => {
    const action = { x: -2, y: 3, rotation: 2, regionId: "road-0", featureType: FEATURE.ROAD };
    expect(createActionPreview(action, { tileId: 7, source: "log" })).toMatchObject({
      x: -2,
      y: 3,
      rotation: 2,
      tileId: 7,
      hasMeeple: true,
      featureLabel: "길",
    });
  });
});

describe("비파괴 기록 트리", () => {
  it("이전/다음으로 상태를 복원하고 객체 참조를 공유하지 않는다", () => {
    const game = makeGame();
    const initialNode = game.history.currentNode;
    completeTurn(game, 1, 0);
    const nextNodeId = game.history.currentId;
    expect(game.board.size).toBe(2);
    expect(game.goToPreviousHistory()).toBe(true);
    expect(game.board.size).toBe(1);
    game.players[0].score = 99;
    expect(initialNode.snapshot.players[0].score).toBe(0);
    expect(game.goToNextHistory()).toBe(true);
    expect(game.history.currentId).toBe(nextNodeId);
    expect(game.board.size).toBe(2);
    expect(game.players[0].score).toBe(0);
  });

  it("과거 행동은 새 분기를 만들고 원래 진행 기록을 삭제하지 않는다", () => {
    const game = makeGame();
    completeTurn(game, 1, 0);
    const originalNodeId = game.history.currentId;
    expect(game.goToPreviousHistory()).toBe(true);
    completeTurn(game, 0, 1);
    const branchNodeId = game.history.currentId;
    expect(branchNodeId).not.toBe(originalNodeId);
    expect(game.history.currentNode.branchKind).toBe("branch");
    expect(game.history.nodes.has(originalNodeId)).toBe(true);
    expect(game.history.nodes.get(game.history.rootId).children).toEqual(expect.arrayContaining([originalNodeId, branchNodeId]));

    expect(game.goToPreviousHistory()).toBe(true);
    expect(game.goToNextHistory()).toBe(true);
    expect(game.history.currentId).toBe(originalNodeId);
    expect(game.board.has(1, 0)).toBe(true);
    expect(game.goToPreviousHistory()).toBe(true);
    expect(game.goToNextHistory(branchNodeId)).toBe(true);
    expect(game.board.has(0, 1)).toBe(true);
  });
});

describe("AI 턴 방식과 종료 후 복귀", () => {
  it("자동 진행에서는 자동 실행만, 클릭 진행에서는 버튼 실행만 허용한다", () => {
    const game = makeGame("ai", { aiTurnMode: AI_TURN_MODE.AUTO });
    expect(game.phase).toBe(PHASE.ROTATE_OR_PLACE);
    expect(canRunAiTurn(game)).toBe(true);
    expect(canRunAiTurn(game, { manual: true })).toBe(false);
    game.setAiTurnMode(AI_TURN_MODE.CLICK);
    expect(canRunAiTurn(game)).toBe(false);
    expect(canRunAiTurn(game, { manual: true })).toBe(true);
  });

  it("게임 종료 화면에서 시작 설정 화면 상태로 전환할 수 있다", () => {
    const makeClassList = (initial) => {
      const values = new Set(initial);
      return { add: (name) => values.add(name), remove: (name) => values.delete(name), contains: (name) => values.has(name) };
    };
    const elements = {
      "game-screen": { classList: makeClassList([]) },
      "start-screen": { classList: makeClassList(["is-hidden"]) },
    };
    showSetupScreen(elements);
    expect(elements["game-screen"].classList.contains("is-hidden")).toBe(true);
    expect(elements["start-screen"].classList.contains("is-hidden")).toBe(false);
  });
});
