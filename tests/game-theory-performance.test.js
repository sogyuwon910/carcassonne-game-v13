import { describe, expect, it } from "vitest";
import { PHASE } from "../js/config.js";
import {
  evaluateGameTheoryTurn,
  evaluateGameTheoryTurnBaseline,
  gameTheoryBestResponseStrategy,
  generateSearchLegalActions,
} from "../js/gameTheoryBestResponse.js";
import { GameEngine } from "../js/game.js";
import { TileDefinition, TileInstance } from "../js/tile.js";

const field = new TileDefinition({
  id: 31,
  count: 1,
  draw_count: 1,
  edges: { 1: "F", 2: "F", 3: "F", 4: "F" },
  city_groups: [],
  road_groups: [],
});
const monastery = new TileDefinition({
  id: 32,
  count: 1,
  draw_count: 1,
  edges: { 1: "F", 2: "F", 3: "F", 4: "F" },
  city_groups: [],
  road_groups: [],
  monastery: true,
});

function benchmarkGame(side) {
  const game = new GameEngine([field, monastery], { random: () => 0 });
  for (let x = 0; x < side; x += 1) {
    for (let y = 0; y < side; y += 1) game.board.place(new TileInstance(field), x, y);
  }
  game.players = [
    { id: 0, name: "AI", type: "ai", aiProfileId: "gameTheoryBestResponse", score: side, meeples: 7 },
    { id: 1, name: "A", type: "human", aiProfileId: null, score: side + 1, meeples: 7 },
  ];
  game.deck = [field, field, field, field, field, field, monastery, monastery, monastery]
    .map((definition) => new TileInstance(definition));
  game.currentPlayerIndex = 0;
  game.currentTile = new TileInstance(monastery);
  game.phase = PHASE.ROTATE_OR_PLACE;
  return game;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function compareOne(game) {
  const actions = generateSearchLegalActions(game);
  const makeContext = () => gameTheoryBestResponseStrategy.prepareTurnContext(game, 0, () => 0);
  const baselineContext = makeContext();
  const optimizedContext = makeContext();
  const baseline = await evaluateGameTheoryTurnBaseline(game, actions, baselineContext, {
    random: () => 0,
    yieldEvery: Number.MAX_SAFE_INTEGER,
    yieldBetweenCandidates: false,
  });
  const optimized = await evaluateGameTheoryTurn(game, actions, optimizedContext, {
    random: () => 0,
    yieldEvery: Number.MAX_SAFE_INTEGER,
    yieldBetweenCandidates: false,
  });
  expect(optimized.selection.evaluation.action).toEqual(baseline.selection.evaluation.action);
  expect(optimized.evaluations.map((item) => item.value))
    .toEqual(baseline.evaluations.map((item) => item.value));
  return {
    baseline: baselineContext.performanceCounters,
    optimized: optimizedContext.performanceCounters,
  };
}

describe("??? AI 성능 계측", () => {
  it("초반·중반·후반 고정 상태에서 중앙 실행 시간을 기록하고 구조적 작업량을 줄인다", async () => {
    const report = [];
    for (const [label, side] of [["초반", 1], ["중반", 2], ["후반", 3]]) {
      const runs = [];
      for (let repeat = 0; repeat < 5; repeat += 1) runs.push(await compareOne(benchmarkGame(side)));
      const baselineTimes = runs.map((run) => run.baseline.totalSearchTimeMs);
      const optimizedTimes = runs.map((run) => run.optimized.totalSearchTimeMs);
      const sample = runs[0];
      expect(sample.optimized.fullStateCloneCount).toBe(1);
      expect(sample.optimized.fullStateCloneCount).toBeLessThan(sample.baseline.fullStateCloneCount);
      expect(sample.optimized.actionApplyCount).toBe(sample.optimized.actionUndoCount);
      expect(sample.optimized.drawApplyCount).toBe(sample.optimized.drawUndoCount);
      expect(sample.optimized.stateKeyBuildCount).toBeLessThan(sample.baseline.stateKeyBuildCount);
      report.push({
        label,
        candidates: sample.optimized.selfCandidateCount,
        baselineMedianMs: Number(median(baselineTimes).toFixed(2)),
        optimizedMedianMs: Number(median(optimizedTimes).toFixed(2)),
        baselineClones: sample.baseline.fullStateCloneCount,
        optimizedClones: sample.optimized.fullStateCloneCount,
        baselineStateKeys: sample.baseline.stateKeyBuildCount,
        optimizedStateKeys: sample.optimized.stateKeyBuildCount,
        baselineLegalActionGenerations: sample.baseline.legalActionGenerationCalls,
        optimizedLegalActionGenerations: sample.optimized.legalActionGenerationCalls,
        baselineValueCalculations: sample.baseline.stateValueCalculationCount,
        optimizedValueCalculations: sample.optimized.stateValueCalculationCount,
        baselineFutureCalculations: sample.baseline.futureValueCalculationCount,
        optimizedFutureCalculations: sample.optimized.futureValueCalculationCount,
        optimizedCompactLogs: sample.optimized.compactLogRecordCount,
        baselineCloneTimeMs: Number(sample.baseline.fullStateCloneTimeMs.toFixed(2)),
        optimizedCloneTimeMs: Number(sample.optimized.fullStateCloneTimeMs.toFixed(2)),
        baselineStateKeyTimeMs: Number(sample.baseline.stateKeyBuildTimeMs.toFixed(2)),
        optimizedStateKeyTimeMs: Number(sample.optimized.stateKeyBuildTimeMs.toFixed(2)),
        baselineValueTimeMs: Number(sample.baseline.stateValueCalculationTimeMs.toFixed(2)),
        optimizedValueTimeMs: Number(sample.optimized.stateValueCalculationTimeMs.toFixed(2)),
      });
    }
    console.info(`GAME_THEORY_BENCHMARK ${JSON.stringify(report)}`);
  });
});
