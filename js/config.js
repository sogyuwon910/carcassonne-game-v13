// 게임 전역 상수입니다. 규칙과 화면 양쪽에서 같은 방향 체계를 사용합니다.
export const TERRAIN = Object.freeze({ FIELD: "F", ROAD: "R", CITY: "C" });
export const FEATURE = Object.freeze({ ROAD: "road", CITY: "city", MONASTERY: "monastery" });
export const PHASE = Object.freeze({
  SETUP: "SETUP",
  DRAW_TILE: "DRAW_TILE",
  ROTATE_OR_PLACE: "ROTATE_OR_PLACE",
  PLACE_MEEPLE_OR_SKIP: "PLACE_MEEPLE_OR_SKIP",
  SCORE_COMPLETED_FEATURES: "SCORE_COMPLETED_FEATURES",
  NEXT_TURN: "NEXT_TURN",
  GAME_OVER: "GAME_OVER",
});

// AI 차례를 즉시 이어 갈지, 버튼을 누를 때 한 번씩 실행할지 정합니다.
export const AI_TURN_MODE = Object.freeze({ AUTO: "auto", CLICK: "click" });

export const DIRECTIONS = Object.freeze({
  1: { name: "N", dx: 0, dy: 1, opposite: 3 },
  2: { name: "E", dx: 1, dy: 0, opposite: 4 },
  3: { name: "S", dx: 0, dy: -1, opposite: 1 },
  4: { name: "W", dx: -1, dy: 0, opposite: 2 },
});

export const PLAYER_COLORS = ["#e33d48", "#277be8", "#f0b429", "#9b51e0"];
export const MEEPLES_PER_PLAYER = 7;
export const TILE_SIZE = 100;

export function coordinateKey(x, y) { return `${x},${y}`; }
export function nodeKey(x, y, regionId) { return `${x},${y}:${regionId}`; }
export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
