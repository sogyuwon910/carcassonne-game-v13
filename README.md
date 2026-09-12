# 타일 왕국: 개척자의 길

카르카손 방식의 타일 연결 규칙을 참고해 만든 2~4인용 로컬 전략 보드게임입니다. 게임 코드는 바닐라 HTML5, CSS3, JavaScript ES Module로 작성되었으며 외부 서버나 데이터베이스를 사용하지 않습니다.

## 실행 방법

가장 쉬운 방법은 VSCode에서 이 폴더를 열고 `index.html`을 **Live Server**로 실행하는 것입니다. ES Module과 `tiles.json`은 브라우저 보안 정책상 `file://`로 직접 열면 로딩이 막힐 수 있습니다.

Node.js가 설치되어 있다면 다음 방법도 사용할 수 있습니다.

```bash
npm install
npm run dev
```

터미널에 표시된 로컬 주소를 브라우저에서 여세요.

## 테스트

```bash
npm install
npm test
```

Vitest가 타일 회전, 배치 판정, 도로 연결, 미플 점유, 점수, 수도원 완성을 검사합니다.

## 폴더 구조

- `index.html` — 시작 화면과 게임 화면 DOM
- `css/styles.css` — 전체 레이아웃, 반응형 UI, 보드 패널 스타일
- `js/config.js` — 방향, 지형, 단계 상수
- `js/tile.js` — 타일 데이터와 회전
- `js/board.js` — 무한 좌표 보드와 배치 판정
- `js/featureGraph.js` — 성·도로 연결, 완성, 미플 점유 탐색
- `js/scoring.js` — 완성/게임 종료 점수와 미플 회수
- `js/game.js` — 플레이어, 덱, 턴 상태 흐름
- `js/ai.js` — 공통 합법 행동 생성, 후보 시뮬레이션, 전략 실행·조언 진입점
- `js/aiValues.js` — 공통 `C`, `N`, `I`, `F`, 남은 턴, `m_i`, `r_i` 계산
- `js/aiStrategies.js` — 8개 AI의 필터·가치 함수·선택·전략 설명
- `js/aiProfiles.js` — 8개 AI의 ID, 이름, 설명, 전략 연결 정보
- `js/aiTurnPolicy.js` — 자동 진행/클릭 진행 실행 조건
- `js/actionPreview.js` — AI 로그와 조언 행동의 보드 미리보기 데이터
- `js/history.js` — 깊은 스냅샷을 사용하는 비파괴 기록 트리
- `js/renderer.js` — Canvas 보드, 타일, 미플, 카메라
- `js/ui.js` — 버튼, 패널, 모달과 게임 연결
- `assets/data/tiles.json` — 24종/72장 타일 기준 데이터
- `assets/tiles/` — 제공된 타일 PNG 24장
- `tests/` — 규칙 자동 테스트

## 조작법

- `R`: 현재 타일을 시계 방향 90도 회전
- 초록/금색 후보 칸 클릭: 타일 배치
- 턴을 마치기 전 다른 후보 칸 클릭: 방금 놓은 타일 이동
- 턴을 마치기 전 방금 놓은 타일 클릭: 배치를 취소하고 다시 회전·배치
- 타일 위 `+` 표시 클릭: 미플 위치 선택
- 우클릭·가운데 클릭·터치 드래그: 보드 이동
- 마우스 휠 또는 `+ / −`: 확대·축소
- `ESC`: 선택한 미플 취소
- `H`: 도움말

## AI 수정 위치

공통 계산은 `js/aiValues.js`에 분리되어 있습니다.

- `calculateCompletedScoreValue`: `C_p(S)`
- `calculateIncompleteScoreValue`: `N_p(S)`
- `calculateImmediateValue`: `I(S)`
- `completionProbability`: 구조물 완성 확률
- `calculateFutureValue`: `F(S)`
- `calculateRemainingOwnTurns`: 이번 턴을 포함한 자기 남은 턴 수
- `calculateActionMetrics`: 후보 결과의 `C_i`, `N_i`, `I_i`, `F_i`, `m_i`, `r_i`

`js/ai.js`의 `generateLegalActions`와 `generateMeepleActions`가 합법 행동을 만들고, `chooseAiAction`/`chooseAiAdvice`가 전략을 실행합니다. `js/aiStrategies.js`에서 각 전략의 `prepareTurnContext`, `filterActions`, `evaluateAction`, `selectAction`, `describeStrategy`를 독립적으로 수정할 수 있습니다.

모든 후보는 기존 `GameEngine.simulateAction()`을 통해 복사 상태에 적용되므로 타일 배치, 미플 합법성, 연결, 완성, 점수 계산 규칙은 사람 플레이와 같습니다.

## 추가된 AI와 진행 기능

- 각 플레이어는 사람 또는 기본/허서연/이수완/정재이/손건후/김규민/장성이/소규원 AI를 선택할 수 있습니다.
- 기본/허서연/소규원은 서로 다른 전략 ID를 유지하면서 `V=I+F`를 사용합니다. 이수완은 턴별 난수 가중치, 정재이는 기본 가치 선두의 `F` 견제, 장성이는 수도원·완성 점수, 손건후는 미플 소진·회수, 김규민은 완성 점수 선두의 `F=0` 행동 우선을 사용합니다.
- 사람 차례의 **AI에게 물어보기**는 원본 상태의 깊은 복사본에서 선택한 AI 전략을 실행합니다. 추천 좌표·회전·미플과 실제 전략 조건·계산값은 표시만 하며 자동 적용하지 않습니다.
- `AI LOG`의 **현재 AI 전략** 영역에서 가치 함수, 턴 조건, 합법/필터/평가 후보 수, 최종 행동·이유와 후보별 값을 확인할 수 있습니다.
- AI 로그 후보 행에 마우스를 올리거나 키보드 포커스를 두면 해당 타일과 미플 행동이 보드에 반투명으로 표시됩니다.
- **자동 진행**은 AI 차례를 계속 실행하고, **클릭 진행**은 `AI 행동 실행` 버튼을 누를 때마다 AI 한 명의 턴만 실행합니다. 시작 화면과 게임 화면에서 설정할 수 있습니다.

## 기록 이동과 분기

정상적으로 끝난 각 턴과 게임 종료 상태는 기록 트리에 저장됩니다. 보드, 타일 회전, 미플, 점수, 덱/버린 타일/현재 타일, 플레이어·라운드·단계, AI 로그를 타일 ID 기반 순수 데이터로 직렬화하므로 기록 간 객체 참조가 공유되지 않습니다.

- `이전`/`다음`으로 저장된 상태를 복원합니다.
- 다음 기록이 여러 개면 가운데 분기 선택 상자에서 원래 기록 또는 새 기록을 고릅니다.
- 과거 상태에서 행동하면 기존 자식을 삭제하지 않고 `새 기록 N` 분기를 만듭니다.
- 게임 종료 창에서 같은 설정으로 재시작하거나, 시작 설정으로 돌아가거나, 종료 직전 기록을 바로 볼 수 있습니다.

## 새 자동 테스트 범위

`tests/ai-strategies.test.js`는 공통 `C/N/I/F`, 비파괴 후보 평가, 8개 전략의 턴 준비·필터·가치·우선순위·난수, 로그와 조언을 검사합니다. `tests/new-features.test.js`는 8개 독립 전략 연결, 조언의 비파괴성, 로그 좌표 변환, 기록 트리와 AI 진행 정책을 검사합니다.
