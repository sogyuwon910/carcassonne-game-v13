import { FEATURE } from "./config.js";

export const FEATURE_LABELS = Object.freeze({
  [FEATURE.CITY]: "성",
  [FEATURE.ROAD]: "길",
  [FEATURE.MONASTERY]: "수도원",
});

// AI 로그와 AI 조언이 같은 형식의 읽기 전용 보드 미리보기를 사용하도록 변환합니다.
export function createActionPreview(action, { tileId, source = "log", profileName = "AI" } = {}) {
  if (!action || !Number.isFinite(action.x) || !Number.isFinite(action.y)) return null;
  return {
    x: action.x,
    y: action.y,
    rotation: action.rotation ?? 0,
    regionId: action.regionId ?? null,
    featureType: action.featureType ?? null,
    tileId,
    source,
    profileName,
    hasMeeple: Boolean(action.regionId),
    featureLabel: action.regionId ? (FEATURE_LABELS[action.featureType] ?? action.featureType ?? "구조물") : "놓지 않음",
  };
}
