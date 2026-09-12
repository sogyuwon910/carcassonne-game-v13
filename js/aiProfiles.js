// AI의 화면 표시 정보와 사용할 전략 ID를 한곳에서 관리합니다.
// 기본 공식을 공유하는 프로필도 독립 ID를 유지해 나중에 따로 수정할 수 있습니다.
const PROFILE_DATA = [
  { id: "basic", name: "기본 AI", description: "V=I+F 기본 가치로 행동을 고릅니다.", strategyId: "basic" },
  { id: "heo-seoyeon", name: "허서연 AI", description: "독립 프로필에서 V=I+F 기본 가치를 사용합니다.", strategyId: "heo-seoyeon" },
  { id: "lee-suwan", name: "이수완 AI", description: "턴마다 k를 뽑아 I와 F의 가중치 및 미플 배치 성향을 바꿉니다.", strategyId: "lee-suwan" },
  { id: "jeong-jaei", name: "정재이 AI", description: "현재 가장 강한 플레이어의 미래 가치 F를 견제합니다.", strategyId: "jeong-jaei" },
  { id: "son-geonhu", name: "손건후 AI", description: "남은 턴과 미완성 점수를 보고 미플을 쓰며 자기 미플 회수를 선호합니다.", strategyId: "son-geonhu" },
  { id: "kim-gyumin", name: "김규민 AI", description: "꼽사리 패턴, 최고 미래가치 상대 방해, 일반 가치 평가 순서로 행동합니다.", strategyId: "kim-gyumin" },
  { id: "jang-seongi", name: "장성이 AI", description: "수도원 미플을 우선하고 완성 점수와 미플 가치를 함께 봅니다.", strategyId: "jang-seongi" },
  { id: "so-gyuwon", name: "소규원 AI", description: "독립 프로필에서 V=I+F 기본 가치를 사용합니다.", strategyId: "so-gyuwon" },
  { id: "gameTheoryBestResponse", name: "??? AI", description: "가장 가치가 높은 상대의 다음 최선 대응을 예상하여 점수 차이를 최대화합니다.", strategyId: "gameTheoryBestResponse" },
];

export const DEFAULT_AI_PROFILE_ID = "basic";
export const AI_PROFILES = Object.freeze(PROFILE_DATA.map((profile) => Object.freeze({ ...profile })));

// 잘못된 ID가 들어와도 기본 AI로 안전하게 돌아갑니다.
export function getAiProfile(profileId = DEFAULT_AI_PROFILE_ID) {
  return AI_PROFILES.find((profile) => profile.id === profileId) ?? AI_PROFILES[0];
}

export function isAiProfileId(profileId) {
  return AI_PROFILES.some((profile) => profile.id === profileId);
}
