import { AI_TURN_MODE, PHASE } from "./config.js";

// UI와 테스트가 같은 기준으로 AI 자동/클릭 실행 가능 여부를 판단합니다.
export function canRunAiTurn(game, { manual = false, aiThinking = false } = {}) {
  if (!game || aiThinking || game.phase !== PHASE.ROTATE_OR_PLACE || game.currentPlayer?.type !== "ai") return false;
  if (manual) return game.aiTurnMode === AI_TURN_MODE.CLICK;
  return game.aiTurnMode === AI_TURN_MODE.AUTO && !game.history?.isReviewing;
}
