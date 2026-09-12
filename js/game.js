import { Board } from "./board.js";
import { DEFAULT_AI_PROFILE_ID, getAiProfile, isAiProfileId } from "./aiProfiles.js";
import { AI_TURN_MODE, MEEPLES_PER_PLAYER, PHASE, PLAYER_COLORS } from "./config.js";
import { getLegalMeepleOptions } from "./featureGraph.js";
import { cloneHistoryData, HistoryTree } from "./history.js";
import { scoreCompletedAround, scoreGameEnd } from "./scoring.js";
import { TileInstance } from "./tile.js";

function shuffle(items, random = Math.random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

export class GameEngine {
  constructor(definitions, { random = Math.random } = {}) {
    this.definitions = definitions;
    this.definitionMap = new Map(definitions.map((definition) => [definition.id, definition]));
    this.random = random;
    this.listeners = new Set();
    this.history = new HistoryTree();
    this.resetModel();
  }

  resetModel() {
    this.board = new Board();
    this.players = [];
    this.deck = [];
    this.discarded = [];
    this.currentPlayerIndex = 0;
    this.currentTile = null;
    this.lastPlaced = null;
    this.lastPlacement = null;
    this.previewMeeple = null;
    this.phase = PHASE.SETUP;
    this.round = 1;
    this.scoredFeatureKeys = new Set();
    this.turnMessage = "";
    this.lastScoreResults = [];
    this.finalRanking = [];
    this.aiDebug = null;
    this.aiTurnMode = AI_TURN_MODE.AUTO;
    this.history.reset();
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(event = "change") { for (const listener of this.listeners) listener(this, event); }
  get currentPlayer() { return this.players[this.currentPlayerIndex] ?? null; }

  startGame(playerConfigs, { aiTurnMode = AI_TURN_MODE.AUTO } = {}) {
    if (playerConfigs.length < 2 || playerConfigs.length > 4) throw new Error("플레이어는 2명에서 4명까지 가능합니다.");
    this.resetModel();
    this.aiTurnMode = aiTurnMode === AI_TURN_MODE.CLICK ? AI_TURN_MODE.CLICK : AI_TURN_MODE.AUTO;
    this.players = playerConfigs.map((config, index) => {
      const profileId = config.aiProfileId ?? (isAiProfileId(config.type) ? config.type : DEFAULT_AI_PROFILE_ID);
      const isAi = config.type === "ai" || isAiProfileId(config.type);
      const profile = getAiProfile(profileId);
      return {
        id: index,
        name: isAi ? (config.aiProfileId ? profile.name : config.name?.trim() || profile.name) : config.name?.trim() || `플레이어 ${index + 1}`,
        type: isAi ? "ai" : "human",
        aiProfileId: isAi ? profile.id : null,
        color: PLAYER_COLORS[index],
        score: 0,
        meeples: MEEPLES_PER_PLAYER,
      };
    });
    const startDefinition = this.definitionMap.get(1);
    if (!startDefinition) throw new Error("시작 타일 TILE_01을 찾을 수 없습니다.");
    this.board.place(new TileInstance(startDefinition, 0), 0, 0);
    this.deck = [];
    for (const definition of this.definitions) {
      for (let count = 0; count < definition.drawCount; count += 1) this.deck.push(new TileInstance(definition));
    }
    shuffle(this.deck, this.random);
    this.phase = PHASE.DRAW_TILE;
    this.turnMessage = "첫 번째 타일을 뽑았습니다.";
    this.drawNextTile();
    this.history.initialize(this.serializeState(), "게임 시작");
    this.notify("start");
  }

  setAiTurnMode(mode) {
    this.aiTurnMode = mode === AI_TURN_MODE.CLICK ? AI_TURN_MODE.CLICK : AI_TURN_MODE.AUTO;
    this.notify("ai-mode");
    return this.aiTurnMode;
  }

  // 과거 기록에서 첫 행동을 시작하면 다음 턴 완료 시 새 분기로 저장되도록 표시합니다.
  markGameplayMutation() { this.history.markMutation(); }

  drawNextTile() {
    if (this.phase === PHASE.GAME_OVER) return false;
    while (this.deck.length) {
      const tile = this.deck.pop();
      tile.rotation = 0;
      if (this.board.getAllLegalPlacements(tile).length) {
        this.currentTile = tile;
        this.phase = PHASE.ROTATE_OR_PLACE;
        this.turnMessage = `${this.currentPlayer.name}님, 타일을 배치하세요.`;
        this.notify("draw");
        return true;
      }
      this.discarded.push(tile);
      this.turnMessage = `TILE ${String(tile.definition.id).padStart(2, "0")}은 놓을 곳이 없어 버렸습니다.`;
      this.notify("discard");
    }
    this.endGame();
    return false;
  }

  rotateCurrentTile() {
    if (this.phase !== PHASE.ROTATE_OR_PLACE || !this.currentTile) return false;
    this.markGameplayMutation();
    this.currentTile.rotate();
    this.turnMessage = `타일을 ${this.currentTile.rotation * 90}° 회전했습니다.`;
    this.notify("rotate");
    return true;
  }

  placeCurrentTile(x, y) {
    if (this.phase !== PHASE.ROTATE_OR_PLACE || !this.currentTile) return false;
    if (!this.board.canPlace(this.currentTile, x, y)) {
      this.turnMessage = "지형이 맞지 않아 그 칸에는 놓을 수 없습니다.";
      this.notify("invalid-placement");
      return false;
    }
    this.markGameplayMutation();
    this.lastPlaced = this.board.place(this.currentTile, x, y);
    this.lastPlacement = { x, y, playerId: this.currentPlayer.id };
    this.currentTile = null;
    this.phase = PHASE.PLACE_MEEPLE_OR_SKIP;
    this.previewMeeple = null;
    const options = this.getMeepleOptions();
    this.turnMessage = options.length
      ? "미플을 놓거나, 빛나는 다른 칸을 눌러 타일을 옮기세요."
      : "빛나는 다른 칸을 누르면 턴을 마치기 전에 타일을 옮길 수 있습니다.";
    this.notify("place-tile");
    return true;
  }

  getTilePlacementOptions() {
    if (this.phase === PHASE.ROTATE_OR_PLACE && this.currentTile) {
      return this.board.getValidCoordinates(this.currentTile);
    }
    if (this.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.lastPlaced) return [];
    const { x, y, tile } = this.lastPlaced;
    return this.board.getValidCoordinates(tile, { x, y })
      .filter((option) => option.x !== x || option.y !== y);
  }

  repositionCurrentTile(x, y) {
    if (this.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.lastPlaced) return false;
    const previous = this.lastPlaced;
    if (previous.x === x && previous.y === y) return false;
    if (!this.board.canPlace(previous.tile, x, y, previous)) {
      this.turnMessage = "지형이 맞지 않아 그 칸으로 옮길 수 없습니다.";
      this.notify("invalid-placement");
      return false;
    }
    this.markGameplayMutation();
    if (this.previewMeeple) this.cancelMeeple({ notify: false });
    this.board.remove(previous.x, previous.y);
    this.lastPlaced = this.board.place(previous.tile, x, y);
    this.lastPlacement = { x, y, playerId: this.currentPlayer.id };
    const options = this.getMeepleOptions();
    this.turnMessage = options.length
      ? "타일을 옮겼습니다. 미플을 놓거나 턴을 마치세요."
      : "타일을 옮겼습니다. 미플을 놓을 수 있는 빈 구조물은 없습니다.";
    this.notify("reposition-tile");
    return true;
  }

  recallCurrentTile() {
    if (this.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.lastPlaced) return false;
    this.markGameplayMutation();
    if (this.previewMeeple) this.cancelMeeple({ notify: false });
    const { x, y, tile } = this.lastPlaced;
    this.board.remove(x, y);
    this.currentTile = tile;
    this.lastPlaced = null;
    this.lastPlacement = null;
    this.phase = PHASE.ROTATE_OR_PLACE;
    this.turnMessage = "타일을 다시 들었습니다. 회전하거나 새 위치에 놓으세요.";
    this.notify("recall-tile");
    return true;
  }

  getMeepleOptions() {
    if (!this.lastPlaced || this.phase !== PHASE.PLACE_MEEPLE_OR_SKIP) return [];
    return getLegalMeepleOptions(this.board, this.lastPlaced.x, this.lastPlaced.y, this.currentPlayer.meeples);
  }

  cancelMeeple({ notify = true } = {}) {
    if (!this.previewMeeple || !this.lastPlaced) return false;
    this.markGameplayMutation();
    const target = this.previewMeeple;
    this.lastPlaced.meeples = this.lastPlaced.meeples.filter((meeple) => meeple !== target);
    this.currentPlayer.meeples += 1;
    this.previewMeeple = null;
    this.turnMessage = "미플 선택을 취소했습니다.";
    if (notify) this.notify("cancel-meeple");
    return true;
  }

  toggleMeeple(regionId) {
    if (this.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.lastPlaced) return false;
    if (this.previewMeeple?.regionId === regionId) return this.cancelMeeple();
    if (this.previewMeeple) this.cancelMeeple();
    const option = this.getMeepleOptions().find((region) => region.id === regionId);
    if (!option || this.currentPlayer.meeples <= 0) {
      this.turnMessage = "그 구조물에는 미플을 놓을 수 없습니다.";
      this.notify("invalid-meeple");
      return false;
    }
    this.markGameplayMutation();
    const meeple = { playerId: this.currentPlayer.id, type: option.type, regionId: option.id, x: option.x, y: option.y };
    this.lastPlaced.meeples.push(meeple);
    this.currentPlayer.meeples -= 1;
    this.previewMeeple = meeple;
    this.turnMessage = "미플 위치를 선택했습니다. 턴 마치기를 누르세요.";
    this.notify("place-meeple");
    return true;
  }

  finishTurn({ skipMeeple = false } = {}) {
    if (this.phase !== PHASE.PLACE_MEEPLE_OR_SKIP || !this.lastPlaced) return [];
    this.markGameplayMutation();
    if (skipMeeple && this.previewMeeple) this.cancelMeeple();
    this.phase = PHASE.SCORE_COMPLETED_FEATURES;
    this.lastScoreResults = scoreCompletedAround(
      this.board, this.players, this.lastPlaced.x, this.lastPlaced.y, this.scoredFeatureKeys
    );
    const scored = this.lastScoreResults.filter((result) => result.winners.length);
    this.turnMessage = scored.length
      ? scored.map((result) => `${result.feature} ${result.score}점`).join(" · ")
      : "완성된 구조물을 확인했습니다.";
    this.previewMeeple = null;
    this.notify("score");
    return this.lastScoreResults;
  }

  advanceTurn() {
    if (this.phase !== PHASE.SCORE_COMPLETED_FEATURES) return false;
    if (!this.deck.length) { this.endGame(); return true; }
    this.phase = PHASE.NEXT_TURN;
    const previous = this.currentPlayerIndex;
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    if (this.currentPlayerIndex <= previous) this.round += 1;
    this.lastPlaced = null;
    this.lastScoreResults = [];
    this.phase = PHASE.DRAW_TILE;
    this.drawNextTile();
    if (this.phase !== PHASE.GAME_OVER) this.history.record(this.serializeState(), `라운드 ${this.round} · ${this.currentPlayer.name} 차례`);
    this.notify("next-turn");
    return true;
  }

  endGame() {
    if (this.phase === PHASE.GAME_OVER) return;
    this.currentTile = null;
    this.lastScoreResults = scoreGameEnd(this.board, this.players);
    this.phase = PHASE.GAME_OVER;
    this.finalRanking = [...this.players].sort((a, b) => b.score - a.score || a.id - b.id);
    this.turnMessage = "모든 타일을 사용했습니다. 최종 점수를 계산했습니다.";
    if (this.history.currentNode) this.history.record(this.serializeState(), "게임 종료");
    else this.history.initialize(this.serializeState(), "게임 종료");
    this.notify("game-over");
  }

  // 클래스 인스턴스와 Map/Set을 타일 ID 중심의 순수 데이터로 바꿔 안전하게 기록합니다.
  serializeState() {
    const tileData = (tile) => tile ? { definitionId: tile.definition.id, rotation: tile.rotation } : null;
    return {
      board: this.board.values()
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((placed) => ({ x: placed.x, y: placed.y, tile: tileData(placed.tile), meeples: placed.meeples.map((meeple) => ({ ...meeple })) })),
      players: this.players.map((player) => ({ ...player })),
      deck: this.deck.map(tileData),
      discarded: this.discarded.map(tileData),
      currentPlayerIndex: this.currentPlayerIndex,
      currentTile: tileData(this.currentTile),
      lastPlacedPosition: this.lastPlaced ? { x: this.lastPlaced.x, y: this.lastPlaced.y } : null,
      lastPlacement: this.lastPlacement ? { ...this.lastPlacement } : null,
      previewMeeple: this.previewMeeple ? { ...this.previewMeeple } : null,
      phase: this.phase,
      round: this.round,
      scoredFeatureKeys: [...this.scoredFeatureKeys],
      turnMessage: this.turnMessage,
      lastScoreResults: cloneHistoryData(this.lastScoreResults),
      finalRankingIds: this.finalRanking.map((player) => player.id),
      aiDebug: cloneHistoryData(this.aiDebug),
      aiTurnMode: this.aiTurnMode,
    };
  }

  // 기록 데이터로 객체를 새로 만들어 과거와 현재 사이에 참조가 공유되지 않게 합니다.
  restoreState(snapshot) {
    const state = cloneHistoryData(snapshot);
    const makeTile = (data) => {
      if (!data) return null;
      const definition = this.definitionMap.get(data.definitionId);
      if (!definition) throw new Error(`기록에서 TILE ${data.definitionId} 정의를 찾을 수 없습니다.`);
      return new TileInstance(definition, data.rotation);
    };
    this.board = new Board();
    for (const saved of state.board) {
      const placed = this.board.place(makeTile(saved.tile), saved.x, saved.y);
      placed.meeples = saved.meeples.map((meeple) => ({ ...meeple }));
    }
    this.players = state.players.map((player) => ({ ...player }));
    this.deck = state.deck.map(makeTile);
    this.discarded = state.discarded.map(makeTile);
    this.currentPlayerIndex = state.currentPlayerIndex;
    this.currentTile = makeTile(state.currentTile);
    this.lastPlaced = state.lastPlacedPosition
      ? this.board.get(state.lastPlacedPosition.x, state.lastPlacedPosition.y)
      : null;
    this.lastPlacement = state.lastPlacement ? { ...state.lastPlacement } : null;
    this.previewMeeple = state.previewMeeple && this.lastPlaced
      ? this.lastPlaced.meeples.find((meeple) => meeple.playerId === state.previewMeeple.playerId
        && meeple.regionId === state.previewMeeple.regionId) ?? null
      : null;
    this.phase = state.phase;
    this.round = state.round;
    this.scoredFeatureKeys = new Set(state.scoredFeatureKeys);
    this.turnMessage = state.turnMessage;
    this.lastScoreResults = cloneHistoryData(state.lastScoreResults ?? []);
    this.finalRanking = (state.finalRankingIds ?? []).map((id) => this.players.find((player) => player.id === id)).filter(Boolean);
    this.aiDebug = cloneHistoryData(state.aiDebug);
    this.aiTurnMode = state.aiTurnMode === AI_TURN_MODE.CLICK ? AI_TURN_MODE.CLICK : AI_TURN_MODE.AUTO;
    return true;
  }

  goToPreviousHistory() {
    const snapshot = this.history.movePrevious();
    if (!snapshot) return false;
    this.restoreState(snapshot);
    this.notify("history");
    return true;
  }

  goToNextHistory(childId = null) {
    const snapshot = this.history.moveNext(childId);
    if (!snapshot) return false;
    this.restoreState(snapshot);
    this.notify("history");
    return true;
  }

  // AI 후보마다 원본 상태가 달라지지 않도록 완전히 독립된 복사본을 만듭니다.
  cloneForSimulation({ includeAiDebug = true } = {}) {
    const clone = new GameEngine(this.definitions, { random: this.random });
    clone.board = this.board.clone();
    clone.players = this.players.map((player) => ({ ...player }));
    clone.deck = this.deck.map((tile) => tile.clone());
    clone.discarded = this.discarded.map((tile) => tile.clone());
    clone.currentPlayerIndex = this.currentPlayerIndex;
    clone.currentTile = this.currentTile?.clone() ?? null;
    clone.lastPlaced = this.lastPlaced ? clone.board.get(this.lastPlaced.x, this.lastPlaced.y) : null;
    clone.lastPlacement = this.lastPlacement ? { ...this.lastPlacement } : null;
    clone.previewMeeple = this.previewMeeple && clone.lastPlaced
      ? clone.lastPlaced.meeples.find((meeple) => meeple.playerId === this.previewMeeple.playerId
        && meeple.regionId === this.previewMeeple.regionId) ?? null
      : null;
    clone.phase = this.phase;
    clone.round = this.round;
    clone.scoredFeatureKeys = new Set(this.scoredFeatureKeys);
    clone.turnMessage = this.turnMessage;
    clone.lastScoreResults = cloneHistoryData(this.lastScoreResults);
    clone.finalRanking = this.finalRanking.map((player) => clone.players.find((item) => item.id === player.id)).filter(Boolean);
    // 탐색 루트에는 이전 턴의 상세 AI 로그가 필요 없습니다. 일반 복사 API의 기존 동작은 유지합니다.
    clone.aiDebug = includeAiDebug ? cloneHistoryData(this.aiDebug) : null;
    clone.aiTurnMode = this.aiTurnMode;
    return clone;
  }

  simulateAction(action) {
    const clone = this.cloneForSimulation();
    clone.listeners.clear();
    if (!clone.currentTile) return null;
    clone.currentTile.rotation = action.rotation;
    if (!clone.placeCurrentTile(action.x, action.y)) return null;
    if (action.regionId) clone.toggleMeeple(action.regionId);
    clone.finishTurn();
    return clone;
  }
}
