import { createActionPreview, FEATURE_LABELS } from "./actionPreview.js";
import { chooseAiAction, chooseAiAdvice } from "./ai.js";
import { AI_PROFILES, getAiProfile } from "./aiProfiles.js";
import { canRunAiTurn } from "./aiTurnPolicy.js";
import { AI_TURN_MODE, PHASE } from "./config.js";
import { GameEngine } from "./game.js";

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));

const sameAction = (left, right) => Boolean(left && right
  && left.x === right.x && left.y === right.y && left.rotation === right.rotation
  && left.regionId === right.regionId);

const formatAiValue = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";

// 화면 성능 계측은 게임 기록 데이터와 분리해 로그를 열어도 직렬화 상태가 달라지지 않게 합니다.
const AI_LOG_PERFORMANCE = new WeakMap();

function updateAiLogPerformance(debug, changes) {
  if (!debug || typeof debug !== "object") return;
  const current = AI_LOG_PERFORMANCE.get(debug) ?? {
    renderCount: 0,
    renderTimeMs: 0,
    detailedBuildCount: 0,
    detailedBuildTimeMs: 0,
  };
  for (const [key, value] of Object.entries(changes)) current[key] += value;
  AI_LOG_PERFORMANCE.set(debug, current);
}

export function getAiLogPerformance(debug) {
  return { ...(AI_LOG_PERFORMANCE.get(debug) ?? {
    renderCount: 0,
    renderTimeMs: 0,
    detailedBuildCount: 0,
    detailedBuildTimeMs: 0,
  }) };
}

function gameplayStateToken(game) {
  const state = game.serializeState();
  delete state.aiDebug;
  delete state.turnMessage;
  return JSON.stringify(state);
}

function actionText(action) {
  if (!action) return "평가 중";
  const feature = action.regionId ? (FEATURE_LABELS[action.featureType] ?? action.featureType ?? "구조물") : "미플 없음";
  return `(${action.x}, ${action.y}) · ${action.rotation * 90}° · ${feature}${action.regionId ? ` (${action.regionId})` : ""}`;
}

function selectedValueItems(evaluation, strategyId) {
  if (!evaluation) return [];
  if (strategyId === "gameTheoryBestResponse") {
    return [
      ["V_self(S_i)", evaluation.selfValue],
      ["R_A(S_i)", evaluation.expectedResponse],
      ["G(x_i)", evaluation.value],
    ];
  }
  const items = [
    ["C_i", evaluation.completed],
    ["N_i", evaluation.incomplete],
    ["I_i", evaluation.immediate],
    ["F_i", evaluation.future],
  ];
  if (Number.isFinite(evaluation.targetFuture)) items.push(["F_A(S_i)", evaluation.targetFuture]);
  if (["jang-seongi", "son-geonhu", "kim-gyumin"].includes(strategyId)) items.push(["m_i", evaluation.meeplesAfter]);
  if (strategyId === "son-geonhu") items.push(["r_i", evaluation.returnedMeeples]);
  if (Number.isFinite(evaluation.meepleValue)) items.push(["M_i", evaluation.meepleValue]);
  items.push(["V_i", evaluation.value]);
  return items;
}

function renderBestResponseDetails(evaluation) {
  if (!evaluation.tileResponses?.length) {
    return "<p class=\"response-empty\">배치 가능한 남은 타일이 없어 R_A(S_i)=V_A(S_i)를 사용했습니다.</p>";
  }
  return `
    <table class="debug-table response-table">
      <thead><tr><th>타일</th><th>수량</th><th>P_i(t)</th><th>A의 행동</th><th>최선 대응 y*</th><th>B_A</th></tr></thead>
      <tbody>${evaluation.tileResponses.map((response) => `
        <tr><td>TILE ${String(response.tileId).padStart(2, "0")}</td><td>${response.count}</td><td>${formatAiValue(response.probability * 100)}%</td><td>${response.responseActionCount}개${response.uniqueResponseStateCount < response.responseActionCount ? ` · 고유 상태 ${response.uniqueResponseStateCount}개` : ""}</td><td>${escapeHtml(actionText(response.bestAction))}${response.tiedBestCount > 1 ? ` · 최고값 동점 ${response.tiedBestCount}개` : ""}</td><td>${formatAiValue(response.bestValue)}</td></tr>`).join("")}</tbody>
    </table>`;
}

// 탐색 때 저장한 숫자만 사용해 사용자가 펼친 한 후보의 상세 표를 그때 만듭니다.
// 가치 함수 호출이나 난수 사용은 전혀 하지 않습니다.
export function buildCandidateLogOnDemand(debug, evaluationIndex) {
  const started = globalThis.performance?.now?.() ?? Date.now();
  const evaluation = debug?.evaluations?.[Number(evaluationIndex)];
  const html = evaluation
    ? renderBestResponseDetails(evaluation)
    : "<p class=\"response-empty\">저장된 후보 계산 결과가 없습니다.</p>";
  updateAiLogPerformance(debug, {
    detailedBuildCount: 1,
    detailedBuildTimeMs: (globalThis.performance?.now?.() ?? Date.now()) - started,
  });
  return html;
}

function renderGameTheoryEvaluations(evaluationRows, debug, interactive) {
  return `
    <div class="strategy-subtitle">후보별 계산</div>
    <table class="debug-table game-theory-table">
      <thead><tr><th>행동 (x,y / 회전 / 미플)</th><th>V_self(S_i)</th><th>배치 가능 물리 타일</th><th>R_A(S_i)</th><th>G(x_i)</th></tr></thead>
      <tbody>${evaluationRows.map(({ item, originalIndex }) => `
        <tr ${interactive ? `tabindex="0" data-debug-index="${originalIndex}"` : ""} class="${sameAction(item.action, debug.selectedAction) ? "is-best" : ""}">
          <td><details data-lazy-response-index="${originalIndex}"><summary>${escapeHtml(actionText(item.action))}</summary><div class="response-lazy">타일별 P_i(t), 상대 최선 대응과 B_A(S_i,t)를 보려면 펼치세요.</div></details></td>
          <td>${formatAiValue(item.selfValue)}</td><td>${item.playableTileCount ?? 0}장</td><td>${formatAiValue(item.expectedResponse)}</td><td>${formatAiValue(item.value)}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function displayShape(shape) {
  return `(${String(shape ?? "----").split("").join(",")})`;
}

function renderKimPatternDetail(evaluation) {
  const detail = evaluation.patternDetail;
  if (!detail) {
    return `<p class="response-empty">패턴 불일치 · F_cH 유지 ${evaluation.targetCityFutureMaintained ? "예" : "아니요"}${Number.isFinite(evaluation.targetCityFutureAfter) ? ` · F_cH(S_i)=${formatAiValue(evaluation.targetCityFutureAfter, 4)}` : ""}</p>`;
  }
  return `<p class="kim-pattern-detail">패턴 일치 · (x₁,y₁)=(${detail.targetX},${detail.targetY}) · (x₂,y₂)=(${detail.actionX},${detail.actionY}) · (dx,dy)=(${detail.dx},${detail.dy}) · T₁=${escapeHtml(displayShape(detail.targetShape))} · T₂=${escapeHtml(displayShape(detail.actionShape))} · 회전 ${detail.patternRotation * 90}° · F_cH(S_i)=${formatAiValue(evaluation.targetCityFutureAfter, 4)} · F_cH 유지 ${evaluation.targetCityFutureMaintained ? "예" : "아니요"}</p>`;
}

function renderKimEvaluations(evaluationRows, debug, interactive) {
  return `
    <div class="strategy-subtitle">후보별 꼽사리·방해·가치 계산</div>
    <table class="debug-table kim-strategy-table">
      <thead><tr><th>행동 (x,y / 회전 / 미플)</th><th>C_i</th><th>N_i</th><th>I_i</th><th>F_i</th><th>m_i</th><th>M_i</th><th>F_A(S_i)</th><th>꼽사리</th><th>V_i</th></tr></thead>
      <tbody>${evaluationRows.map(({ item, originalIndex }) => `
        <tr ${interactive ? `tabindex="0" data-debug-index="${originalIndex}"` : ""} class="${sameAction(item.action, debug.selectedAction) ? "is-best" : ""}">
          <td><details><summary>${escapeHtml(actionText(item.action))}</summary>${renderKimPatternDetail(item)}</details></td>
          <td>${formatAiValue(item.completed)}</td><td>${formatAiValue(item.incomplete)}</td><td>${formatAiValue(item.immediate)}</td><td>${formatAiValue(item.future)}</td><td>${formatAiValue(item.meeplesAfter, 0)}</td><td>${formatAiValue(item.meepleValue)}</td><td>${formatAiValue(item.targetFuture)}</td><td>${item.joinEligible ? "가능" : item.patternMatched ? "패턴만 일치" : "불일치"}</td><td>${formatAiValue(item.value)}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function renderKimContext(description) {
  const opponents = description.opponentFutures ?? [];
  const cities = description.joinCities ?? [];
  return `
    ${opponents.length ? `<div class="strategy-subtitle">상대별 현재 미래가치</div><table class="debug-table"><thead><tr><th>상대</th><th>F_p(S)</th></tr></thead><tbody>${opponents.map((item) => `<tr><td>${escapeHtml(item.playerName)}</td><td>${formatAiValue(item.future, 4)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${cities.length ? `<div class="strategy-subtitle">꼽사리 후보 성</div><table class="debug-table"><thead><tr><th>성</th><th>q_self</th><th>q_opp^max</th><th>F_c(S)</th></tr></thead><tbody>${cities.map((city) => `<tr class="${city.key === description.targetCityKey ? "is-best" : ""}"><td>${escapeHtml(city.key)}</td><td>${city.selfMeeples}</td><td>${city.maxOpponentMeeples}</td><td>${formatAiValue(city.future, 4)}</td></tr>`).join("")}</tbody></table>` : ""}`;
}

// AI 로그와 조언이 같은 구조·표기법으로 전략 조건과 실제 계산값을 보여줍니다.
export function renderAiStrategyReport(debug, { includeEvaluations = true, interactive = false } = {}) {
  if (!debug) return "<p>AI가 행동을 평가하면 전략과 계산값이 표시됩니다.</p>";
  const renderStarted = globalThis.performance?.now?.() ?? Date.now();
  const description = debug.strategyDescription ?? {};
  const selected = debug.evaluations?.find((item) => sameAction(item.action, debug.selectedAction)) ?? null;
  const conditions = description.mainConditions ?? [];
  const playerValues = description.playerValues ?? [];
  const opponentScores = description.opponentCompletedScores ?? [];
  const evaluationRows = (debug.evaluations ?? [])
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => right.item.value - left.item.value);
  const showTargetFuture = evaluationRows.some(({ item }) => Number.isFinite(item.targetFuture));
  const showMeepleValue = evaluationRows.some(({ item }) => Number.isFinite(item.meepleValue));
  const showMeepleCounts = ["jang-seongi", "son-geonhu", "kim-gyumin"].includes(debug.strategyId);
  const showReturned = debug.strategyId === "son-geonhu";
  const isGameTheory = debug.strategyId === "gameTheoryBestResponse";
  const isKimGyumin = debug.strategyId === "kim-gyumin";
  const progress = debug.context?.progress;

  const html = `
    <section class="strategy-report">
      <div class="strategy-report-heading"><span>현재 AI 전략</span><strong>${escapeHtml(debug.profileName ?? "기본 AI")}</strong><small>${escapeHtml(debug.strategyName ?? debug.strategyId ?? "기본 전략")}</small></div>
      <dl class="strategy-facts">
        <div><dt>가치 함수</dt><dd>${escapeHtml(description.valueFormula ?? "—")}</dd></div>
        <div><dt>후보 행동 수</dt><dd>합법 ${debug.candidateCount ?? 0} · 전략 필터 ${debug.filteredCandidateCount ?? 0} · 평가 ${debug.evaluatedCandidateCount ?? 0}</dd></div>
        <div><dt>최종 선택 행동</dt><dd>${escapeHtml(actionText(debug.selectedAction))}</dd></div>
        <div><dt>최종 선택 이유</dt><dd>${escapeHtml(debug.selectedReason ?? description.selectionReason ?? "평가 중")}</dd></div>
        ${isKimGyumin ? `<div><dt>실제 적용 단계</dt><dd>${escapeHtml(description.appliedStage ?? debug.context?.appliedStage ?? "평가 중")}</dd></div>` : ""}
      </dl>
      ${progress ? `<div class="strategy-progress"><progress max="100" value="${Math.max(0, Math.min(100, progress.percent ?? 0))}"></progress><span>${escapeHtml(progress.phase ?? "계산 중")} · ${progress.completedCandidates ?? 0}/${progress.totalCandidates ?? debug.filteredCandidateCount ?? 0} (${progress.percent ?? 0}%)</span></div>` : ""}
      ${conditions.length ? `<ul class="strategy-conditions">${conditions.map((condition) => `<li>${escapeHtml(condition)}</li>`).join("")}</ul>` : ""}
      ${playerValues.length ? `
        <div class="strategy-subtitle">전체 플레이어 현재 가치</div>
        <table class="debug-table strategy-player-table"><thead><tr><th>플레이어</th><th>C</th><th>N</th><th>I</th><th>F</th><th>V</th></tr></thead><tbody>
          ${playerValues.map((item) => `<tr><td>${escapeHtml(item.playerName)}</td><td>${formatAiValue(item.completed)}</td><td>${formatAiValue(item.incomplete)}</td><td>${formatAiValue(item.immediate)}</td><td>${formatAiValue(item.future)}</td><td>${formatAiValue(item.value)}</td></tr>`).join("")}
        </tbody></table>` : ""}
      ${opponentScores.length ? `<p class="strategy-opponents">상대 C_p(S): ${opponentScores.map((item) => `${escapeHtml(item.playerName)} ${formatAiValue(item.completed)}`).join(" · ")}</p>` : ""}
      ${isKimGyumin ? renderKimContext(description) : ""}
      ${selected ? `<div class="strategy-selected-values">${selectedValueItems(selected, debug.strategyId).map(([label, value]) => `<span><small>${escapeHtml(label)}</small>${formatAiValue(value)}</span>`).join("")}</div>` : ""}
      ${includeEvaluations && evaluationRows.length && isGameTheory ? renderGameTheoryEvaluations(evaluationRows, debug, interactive) : ""}
      ${includeEvaluations && evaluationRows.length && isKimGyumin ? renderKimEvaluations(evaluationRows, debug, interactive) : ""}
      ${includeEvaluations && evaluationRows.length && !isGameTheory && !isKimGyumin ? `
        <div class="strategy-subtitle">후보별 계산</div>
        <table class="debug-table"><thead><tr><th>행동 (x,y / 회전 / 미플)</th><th>C</th><th>N</th><th>I</th><th>F</th>${showTargetFuture ? "<th>F_A</th>" : ""}${showMeepleCounts ? "<th>m_i</th>" : ""}${showReturned ? "<th>r_i</th>" : ""}${showMeepleValue ? "<th>M</th>" : ""}<th>V</th></tr></thead><tbody>
          ${evaluationRows.map(({ item, originalIndex }) => `<tr ${interactive ? `tabindex="0" data-debug-index="${originalIndex}"` : ""} class="${sameAction(item.action, debug.selectedAction) ? "is-best" : ""}"><td>${escapeHtml(actionText(item.action))}</td><td>${formatAiValue(item.completed)}</td><td>${formatAiValue(item.incomplete)}</td><td>${formatAiValue(item.immediate)}</td><td>${formatAiValue(item.future)}</td>${showTargetFuture ? `<td>${formatAiValue(item.targetFuture)}</td>` : ""}${showMeepleCounts ? `<td>${formatAiValue(item.meeplesAfter, 0)}</td>` : ""}${showReturned ? `<td>${formatAiValue(item.returnedMeeples, 0)}</td>` : ""}${showMeepleValue ? `<td>${formatAiValue(item.meepleValue)}</td>` : ""}<td>${formatAiValue(item.value)}</td></tr>`).join("")}
        </tbody></table>` : ""}
    </section>`;
  updateAiLogPerformance(debug, {
    renderCount: 1,
    renderTimeMs: (globalThis.performance?.now?.() ?? Date.now()) - renderStarted,
  });
  return html;
}

// 시작 화면 복귀를 한 함수로 모아 종료 화면에서도 같은 동작을 보장합니다.
export function showSetupScreen(elements) {
  elements["game-screen"].classList.add("is-hidden");
  elements["start-screen"].classList.remove("is-hidden");
}

export class GameUI {
  constructor(definitions, renderer) {
    this.definitions = definitions;
    this.renderer = renderer;
    this.playerCount = 2;
    this.game = null;
    this.turnTimer = null;
    this.toastTimer = null;
    this.aiThinking = false;
    this.adviceThinking = false;
    this.aiRequestId = 0;
    this.adviceRequestId = 0;
    this.lastConfigs = null;
    this.lastSettings = { aiTurnMode: AI_TURN_MODE.AUTO };
    this.advicePreview = null;
    this.adviceDebug = null;
    this.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
    this.bindSetup();
    this.bindGameControls();
    this.renderPlayerEditor();
    this.renderAiProfileOptions();
  }

  bindSetup() {
    this.elements["player-count-options"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-count]");
      if (!button) return;
      this.setPlayerCount(Number(button.dataset.count));
      this.renderPlayerEditor();
    });
    this.elements["player-editor"].addEventListener("change", (event) => {
      if (event.target.matches("select")) this.syncPlayerRow(event.target.closest(".player-row"));
    });
    this.elements["start-game-button"].addEventListener("click", () => this.startFromEditor());
    this.elements["exit-button"].addEventListener("click", () => {
      window.close();
      window.setTimeout(() => alert("브라우저 탭은 직접 닫아 주세요."), 100);
    });
  }

  setPlayerCount(count) {
    this.playerCount = count;
    document.querySelectorAll("[data-count]").forEach((option) => {
      const selected = Number(option.dataset.count) === count;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });
  }

  renderPlayerEditor() {
    const profileOptions = AI_PROFILES.map((profile) => `<option value="${profile.id}">${profile.name}</option>`).join("");
    this.elements["player-editor"].innerHTML = Array.from({ length: this.playerCount }, (_, index) => `
      <label class="player-row">
        <span class="player-dot" style="color:var(--player-${index})"></span>
        <input maxlength="14" value="플레이어 ${index + 1}" data-human-name="플레이어 ${index + 1}" aria-label="${index + 1}번 플레이어 이름" />
        <select aria-label="${index + 1}번 플레이어 종류">
          <option value="human">사람</option>
          ${profileOptions}
        </select>
      </label>`).join("");
    const colors = ["#c85f4d", "#4f7ea1", "#d4a73b", "#4f8a68"];
    colors.forEach((color, index) => this.elements["player-editor"].style.setProperty(`--player-${index}`, color));
    const secondRow = this.elements["player-editor"].querySelectorAll(".player-row")[1];
    if (secondRow) {
      secondRow.querySelector("select").value = "basic";
      this.syncPlayerRow(secondRow);
    }
  }

  syncPlayerRow(row) {
    if (!row) return;
    const input = row.querySelector("input");
    const profileId = row.querySelector("select").value;
    if (profileId === "human") {
      input.disabled = false;
      input.value = input.dataset.humanName || `플레이어 ${[...row.parentElement.children].indexOf(row) + 1}`;
      return;
    }
    if (!input.disabled) input.dataset.humanName = input.value;
    input.value = getAiProfile(profileId).name;
    input.disabled = true;
  }

  renderAiProfileOptions() {
    this.elements["advice-ai-select"].innerHTML = AI_PROFILES
      .map((profile) => `<option value="${profile.id}" title="${escapeHtml(profile.description)}">${profile.name}</option>`)
      .join("");
  }

  startFromEditor() {
    const configs = [...this.elements["player-editor"].querySelectorAll(".player-row")].map((row, index) => {
      const selected = row.querySelector("select").value;
      if (selected === "human") {
        return { name: row.querySelector("input").value.trim() || `플레이어 ${index + 1}`, type: "human" };
      }
      const profile = getAiProfile(selected);
      return { name: profile.name, type: "ai", aiProfileId: profile.id };
    });
    this.startGame(configs, { aiTurnMode: this.elements["setup-ai-mode"].value });
  }

  startGame(configs, settings = this.lastSettings) {
    this.cancelPendingWork();
    this.lastConfigs = configs.map((item) => ({ ...item }));
    this.lastSettings = { aiTurnMode: settings.aiTurnMode === AI_TURN_MODE.CLICK ? AI_TURN_MODE.CLICK : AI_TURN_MODE.AUTO };
    this.game = new GameEngine(this.definitions);
    this.game.subscribe((game, event) => this.handleGameEvent(game, event));
    this.renderer.setGame(this.game);
    this.elements["start-screen"].classList.add("is-hidden");
    this.elements["game-screen"].classList.remove("is-hidden");
    this.resetAdvice();
    this.game.startGame(configs, this.lastSettings);
    this.renderer.setGame(this.game);
    this.update();
    this.scheduleAiTurn();
  }

  bindGameControls() {
    this.elements["rotate-button"].addEventListener("click", () => this.game?.rotateCurrentTile());
    this.elements["skip-meeple-button"].addEventListener("click", () => this.finishCurrentTurn(true));
    this.elements["end-turn-button"].addEventListener("click", () => this.finishCurrentTurn(false));
    this.elements["zoom-in-button"].addEventListener("click", () => this.renderer.zoomBy(1.15));
    this.elements["zoom-out-button"].addEventListener("click", () => this.renderer.zoomBy(0.87));
    this.elements["center-board-button"].addEventListener("click", () => this.renderer.centerBoard());
    this.elements["help-button"].addEventListener("click", () => this.elements["help-dialog"].showModal());
    document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
    this.elements["debug-button"].addEventListener("click", () => this.toggleDebug());
    this.elements["close-debug-button"].addEventListener("click", () => this.toggleDebug(false));
    this.elements["brand-button"].addEventListener("click", () => this.returnToSetup());
    this.elements["new-game-button"].addEventListener("click", () => this.returnToSetup());
    this.elements["play-again-button"].addEventListener("click", () => {
      this.elements["game-over-dialog"].close();
      this.startGame(this.lastConfigs, this.lastSettings);
    });
    this.elements["change-players-button"].addEventListener("click", () => {
      this.elements["game-over-dialog"].close();
      this.returnToSetup();
    });
    this.elements["review-history-button"].addEventListener("click", () => {
      this.elements["game-over-dialog"].close();
      this.navigateHistory("previous");
    });
    this.elements["game-ai-mode"].addEventListener("change", (event) => {
      if (!this.game) return;
      this.game.setAiTurnMode(event.target.value);
      this.lastSettings.aiTurnMode = this.game.aiTurnMode;
      if (this.game.aiTurnMode === AI_TURN_MODE.AUTO) this.scheduleAiTurn();
    });
    this.elements["ai-action-button"].addEventListener("click", () => this.runAiTurn({ manual: true }));
    this.elements["ask-ai-button"].addEventListener("click", () => this.requestAdvice());
    this.elements["history-previous-button"].addEventListener("click", () => this.navigateHistory("previous"));
    this.elements["history-next-button"].addEventListener("click", () => this.navigateHistory("next"));
    this.bindDebugPreview();
    this.bindLazyAiLogs();
    window.addEventListener("keydown", (event) => this.handleKeyboard(event));
  }

  bindLazyAiLogs() {
    const bind = (container, getDebug) => {
      container?.addEventListener("toggle", (event) => {
        const details = event.target.closest?.("details[data-lazy-response-index]");
        if (!details?.open || details.dataset.loaded === "true") return;
        const target = details.querySelector(".response-lazy");
        if (!target) return;
        target.innerHTML = buildCandidateLogOnDemand(getDebug(), details.dataset.lazyResponseIndex);
        details.dataset.loaded = "true";
      }, true);
    };
    bind(this.elements["debug-content"], () => this.game?.aiDebug);
    bind(this.elements["advice-result"], () => this.adviceDebug);
  }

  bindDebugPreview() {
    const content = this.elements["debug-content"];
    const showRow = (row) => {
      const evaluation = this.game?.aiDebug?.evaluations?.[Number(row.dataset.debugIndex)];
      if (!evaluation) return;
      this.renderer.setActionPreview(createActionPreview(evaluation.action, {
        tileId: this.game.aiDebug.tileId,
        source: "log",
        profileName: this.game.aiDebug.profileName,
      }));
    };
    content.addEventListener("pointerover", (event) => {
      const row = event.target.closest("[data-debug-index]");
      if (row) showRow(row);
    });
    content.addEventListener("pointerout", (event) => {
      const row = event.target.closest("[data-debug-index]");
      if (row && !row.contains(event.relatedTarget)) this.renderer.setActionPreview(this.advicePreview);
    });
    content.addEventListener("focusin", (event) => {
      const row = event.target.closest("[data-debug-index]");
      if (row) showRow(row);
    });
    content.addEventListener("focusout", (event) => {
      if (event.target.closest("[data-debug-index]")) this.renderer.setActionPreview(this.advicePreview);
    });
  }

  handleKeyboard(event) {
    if (!this.game || this.elements["game-screen"].classList.contains("is-hidden")) return;
    if (event.key.toLowerCase() === "r") this.game.rotateCurrentTile();
    if (event.key.toLowerCase() === "h" && !this.elements["help-dialog"].open) this.elements["help-dialog"].showModal();
    if (event.key === "Escape") this.game.cancelMeeple();
  }

  handleManualBoardAction() {
    this.resetAdvice();
    this.update();
  }

  cancelPendingWork() {
    clearTimeout(this.turnTimer);
    this.aiRequestId += 1;
    this.adviceRequestId += 1;
    this.aiThinking = false;
    this.adviceThinking = false;
  }

  returnToSetup() {
    this.cancelPendingWork();
    this.toggleDebug(false);
    this.renderer.clearActionPreview();
    if (this.lastConfigs) this.applyConfigsToEditor(this.lastConfigs, this.lastSettings);
    showSetupScreen(this.elements);
  }

  applyConfigsToEditor(configs, settings) {
    this.setPlayerCount(configs.length);
    this.renderPlayerEditor();
    [...this.elements["player-editor"].querySelectorAll(".player-row")].forEach((row, index) => {
      const config = configs[index];
      const select = row.querySelector("select");
      const input = row.querySelector("input");
      if (config.type === "ai") {
        select.value = config.aiProfileId ?? "basic";
      } else {
        select.value = "human";
        input.dataset.humanName = config.name;
        input.value = config.name;
      }
      this.syncPlayerRow(row);
    });
    this.elements["setup-ai-mode"].value = settings.aiTurnMode;
  }

  handleGameEvent(game, event) {
    if (["rotate", "place-tile", "reposition-tile", "recall-tile", "place-meeple", "cancel-meeple"].includes(event)) this.resetAdvice();
    if (event === "history") {
      this.cancelPendingWork();
      this.resetAdvice();
      this.renderer.centerBoard();
    }
    this.update();
    if (["invalid-placement", "invalid-meeple", "discard", "score"].includes(event)) this.showToast(game.turnMessage);
    if (["draw", "next-turn"].includes(event)) this.scheduleAiTurn();
    if (event === "game-over") this.showGameOver();
  }

  finishCurrentTurn(skipMeeple) {
    if (!this.game || this.game.currentPlayer.type === "ai" || this.game.phase !== PHASE.PLACE_MEEPLE_OR_SKIP) return;
    this.resetAdvice();
    this.game.finishTurn({ skipMeeple });
    const activeGame = this.game;
    this.turnTimer = window.setTimeout(() => {
      if (this.game === activeGame) this.game.advanceTurn();
    }, 650);
  }

  scheduleAiTurn() {
    if (!canRunAiTurn(this.game, { aiThinking: this.aiThinking })) return;
    this.runAiTurn({ manual: false });
  }

  async runAiTurn({ manual }) {
    const game = this.game;
    if (!canRunAiTurn(game, { manual, aiThinking: this.aiThinking })) return;
    const requestId = ++this.aiRequestId;
    this.aiThinking = true;
    game.turnMessage = `${game.currentPlayer.name}가 가능한 행동을 비교하고 있습니다…`;
    this.update();
    const stateToken = gameplayStateToken(game);
    let lastStateCheck = 0;
    let stateChanged = false;
    const searchCancelled = () => {
      if (this.game !== game || requestId !== this.aiRequestId) return true;
      const checkTime = Date.now();
      if (!stateChanged && checkTime - lastStateCheck >= 60) {
        lastStateCheck = checkTime;
        stateChanged = gameplayStateToken(game) !== stateToken;
      }
      return stateChanged;
    };
    const resultPromise = chooseAiAction(game, game.currentPlayer.aiProfileId, {
      onPrepared: (debug) => {
        if (this.game !== game || requestId !== this.aiRequestId) return;
        game.aiDebug = debug;
        this.renderDebug();
      },
      onProgress: (debug) => {
        if (this.game !== game || requestId !== this.aiRequestId) return;
        game.aiDebug = debug;
        const progress = debug.context?.progress;
        if (progress) game.turnMessage = `${game.currentPlayer.name} 계산 중 · ${progress.completedCandidates}/${progress.totalCandidates} (${progress.percent}%)`;
        this.renderDebug();
        this.update();
      },
      shouldCancel: searchCancelled,
    });
    await new Promise((resolve) => setTimeout(resolve, manual ? 120 : 420));
    const result = await resultPromise;
    if (this.game !== game || requestId !== this.aiRequestId || gameplayStateToken(game) !== stateToken
      || game.phase !== PHASE.ROTATE_OR_PLACE || game.currentPlayer.type !== "ai") {
      if (this.game === game) { this.aiThinking = false; this.update(); }
      return;
    }
    game.aiDebug = result.debug;
    this.renderDebug();
    if (!result.action) { this.aiThinking = false; this.update(); return; }
    const action = result.action;
    this.renderer.setActionPreview(createActionPreview(action, {
      tileId: result.debug.tileId,
      source: "log",
      profileName: game.currentPlayer.name,
    }));
    game.currentTile.rotation = action.rotation;
    game.placeCurrentTile(action.x, action.y);
    if (action.regionId) game.toggleMeeple(action.regionId);
    await new Promise((resolve) => setTimeout(resolve, 520));
    if (this.game !== game || requestId !== this.aiRequestId) return;
    game.finishTurn();
    await new Promise((resolve) => setTimeout(resolve, 620));
    if (this.game !== game || requestId !== this.aiRequestId) return;
    this.renderer.clearActionPreview();
    this.aiThinking = false;
    game.advanceTurn();
  }

  async requestAdvice() {
    const game = this.game;
    if (!game || this.adviceThinking || game.currentPlayer.type !== "human"
      || ![PHASE.ROTATE_OR_PLACE, PHASE.PLACE_MEEPLE_OR_SKIP].includes(game.phase)) return;
    const profile = getAiProfile(this.elements["advice-ai-select"].value);
    const requestId = ++this.adviceRequestId;
    const stateBefore = JSON.stringify(game.serializeState());
    const stateToken = gameplayStateToken(game);
    let lastStateCheck = 0;
    let stateChanged = false;
    const adviceCancelled = () => {
      if (this.game !== game || requestId !== this.adviceRequestId) return true;
      const checkTime = Date.now();
      if (!stateChanged && checkTime - lastStateCheck >= 60) {
        lastStateCheck = checkTime;
        stateChanged = gameplayStateToken(game) !== stateToken;
      }
      return stateChanged;
    };
    this.adviceThinking = true;
    this.elements["ask-ai-button"].disabled = true;
    this.elements["advice-result"].textContent = `${profile.name}가 현재 상황을 계산하고 있습니다…`;
    const result = await chooseAiAdvice(game, profile.id, {
      shouldCancel: adviceCancelled,
      onProgress: (debug) => {
        if (this.game !== game || requestId !== this.adviceRequestId) return;
        const progress = debug.context?.progress;
        if (progress) this.elements["advice-result"].textContent = `${profile.name} 계산 중 · ${progress.completedCandidates}/${progress.totalCandidates} (${progress.percent}%)`;
      },
    });
    if (this.game !== game || requestId !== this.adviceRequestId || JSON.stringify(game.serializeState()) !== stateBefore) {
      if (this.game === game) {
        this.adviceThinking = false;
        this.elements["advice-result"].textContent = "상황이 바뀌어 이전 조언 계산을 취소했습니다.";
        this.update();
      }
      return;
    }
    this.adviceThinking = false;
    this.adviceDebug = result.debug;
    if (!result.action || !result.evaluation) {
      this.elements["advice-result"].textContent = `${profile.name}가 추천할 수 있는 행동이 없습니다.`;
      this.update();
      return;
    }
    this.advicePreview = createActionPreview(result.action, {
      tileId: result.debug.tileId,
      source: "advice",
      profileName: profile.name,
    });
    this.renderer.setActionPreview(this.advicePreview);
    const action = result.action;
    const meepleText = action.regionId ? `${FEATURE_LABELS[action.featureType] ?? action.featureType} (${action.regionId})` : "놓지 않음";
    this.elements["advice-result"].innerHTML = `
      <strong>${profile.name}의 추천</strong>
      좌표 (${action.x}, ${action.y}) · 회전 ${action.rotation * 90}°<br />미플: ${meepleText}
      ${renderAiStrategyReport(result.debug, { includeEvaluations: true, interactive: false })}`;
    this.update();
  }

  resetAdvice() {
    this.adviceRequestId += 1;
    this.adviceThinking = false;
    this.advicePreview = null;
    this.adviceDebug = null;
    this.renderer.clearActionPreview();
    if (this.elements["advice-result"]) this.elements["advice-result"].textContent = "AI를 선택하고 조언을 요청하세요.";
  }

  navigateHistory(direction) {
    if (!this.game || this.aiThinking || this.game.history.pendingBranch) return;
    this.cancelPendingWork();
    this.resetAdvice();
    const moved = direction === "previous"
      ? this.game.goToPreviousHistory()
      : this.game.goToNextHistory(this.elements["history-next-branch"].value || null);
    if (moved) this.showToast(this.game.history.isReviewing ? "과거 기록을 보고 있습니다." : "현재 진행 기록으로 돌아왔습니다.");
  }

  update() {
    const game = this.game;
    if (!game?.currentPlayer) return;
    const player = game.currentPlayer;
    this.elements["round-label"].textContent = `ROUND ${String(game.round).padStart(2, "0")}`;
    this.elements["turn-title"].textContent = player.type === "ai" ? `${player.name}의 차례` : `${player.name}님의 차례`;
    this.elements["current-color"].style.background = player.color;
    this.elements["current-player-name"].textContent = player.name;
    this.elements["current-meeples"].textContent = player.meeples;
    this.elements["tiles-left"].textContent = game.deck.length;
    this.elements["current-score"].textContent = player.score;
    const shownTile = game.currentTile ?? game.lastPlaced?.tile;
    if (shownTile) {
      this.elements["current-tile-image"].src = shownTile.imageUrl;
      this.elements["current-tile-image"].style.transform = `rotate(${shownTile.rotation * 90}deg)`;
      this.elements["tile-id-label"].textContent = `TILE ${String(shownTile.definition.id).padStart(2, "0")}`;
      this.elements["rotation-label"].textContent = `${shownTile.rotation * 90}°`;
    }
    const isHuman = player.type === "human";
    this.elements["rotate-button"].disabled = !(isHuman && game.phase === PHASE.ROTATE_OR_PLACE);
    this.elements["skip-meeple-button"].disabled = !(isHuman && game.phase === PHASE.PLACE_MEEPLE_OR_SKIP);
    this.elements["end-turn-button"].disabled = !(isHuman && game.phase === PHASE.PLACE_MEEPLE_OR_SKIP);
    this.elements["action-hint"].textContent = game.turnMessage;
    this.elements["game-ai-mode"].value = game.aiTurnMode;
    this.elements["ai-action-button"].disabled = !(player.type === "ai" && game.phase === PHASE.ROTATE_OR_PLACE
      && game.aiTurnMode === AI_TURN_MODE.CLICK && !this.aiThinking);
    const canAsk = isHuman && [PHASE.ROTATE_OR_PLACE, PHASE.PLACE_MEEPLE_OR_SKIP].includes(game.phase);
    this.elements["advice-panel"].classList.toggle("is-hidden", !canAsk);
    this.elements["ask-ai-button"].disabled = !canAsk || this.adviceThinking;
    this.renderScores();
    this.renderPhase();
    this.renderHistory();
    this.renderDebug();
  }

  renderScores() {
    this.elements["score-list"].innerHTML = this.game.players.map((player, index) => `
      <article class="score-player ${index === this.game.currentPlayerIndex ? "is-current" : ""}" style="color:${player.color}">
        <span class="score-avatar" title="${escapeHtml(player.name)} · 팀 ${index + 1}">${index + 1}</span>
        <strong>${player.score}</strong><small>${escapeHtml(player.name)}</small>
      </article>`).join("");
  }

  renderPhase() {
    const phaseMap = {
      [PHASE.ROTATE_OR_PLACE]: ["1", "타일을 놓을 위치를 고르세요", "빛나는 칸에만 배치할 수 있습니다"],
      [PHASE.PLACE_MEEPLE_OR_SKIP]: ["2", "배치를 확인하고 미플을 선택하세요", "타일 또는 빛나는 칸을 누르면 다시 놓을 수 있습니다"],
      [PHASE.SCORE_COMPLETED_FEATURES]: ["3", "완성된 구조물을 계산합니다", "점수와 미플 회수를 확인하고 있습니다"],
      [PHASE.GAME_OVER]: ["4", "왕국이 완성되었습니다", "이전/다음 버튼으로 전체 기록을 볼 수 있습니다"],
    };
    const [index, title, description] = phaseMap[this.game.phase] ?? ["·", "다음 차례를 준비합니다", this.game.turnMessage];
    this.elements["phase-index"].textContent = index;
    this.elements["phase-title"].textContent = title;
    this.elements["phase-description"].textContent = description;
  }

  renderHistory() {
    const history = this.game.history;
    const status = history.getStatus();
    if (!status) return;
    this.elements["history-status"].textContent = `기록 ${status.position}/${status.total} · ${status.branchLabel}${status.isReviewing ? " · 과거 보기" : ""}`;
    this.elements["history-previous-button"].disabled = !history.canGoPrevious || this.aiThinking;
    this.elements["history-next-button"].disabled = !history.canGoNext || this.aiThinking;
    const choices = history.getNextChoices();
    this.elements["history-next-branch"].innerHTML = choices
      .map((choice) => `<option value="${choice.id}">${escapeHtml(choice.label)}</option>`).join("");
    this.elements["history-next-branch"].disabled = choices.length <= 1 || this.aiThinking;
    this.elements["history-warning"].textContent = status.pendingBranch
      ? "새 분기에서 행동 중입니다. 턴이 끝나면 원래 기록을 보존한 채 저장됩니다."
      : status.isReviewing
        ? "과거 기록을 보고 있습니다. 여기서 행동하면 새로운 기록 분기가 만들어집니다."
        : "";
  }

  showToast(message) {
    const toast = this.elements["board-toast"];
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2100);
  }

  toggleDebug(force) {
    const drawer = this.elements["debug-drawer"];
    const open = force ?? !drawer.classList.contains("is-open");
    drawer.classList.toggle("is-open", open);
    drawer.setAttribute("aria-hidden", String(!open));
    this.elements["debug-button"].setAttribute("aria-pressed", String(open));
    if (!open) this.renderer.setActionPreview(this.advicePreview);
  }

  renderDebug() {
    const debug = this.game?.aiDebug;
    if (!debug) {
      this.elements["debug-content"].innerHTML = "<p>AI가 행동을 평가하면 현재 전략과 후보별 C(S), N(S), I(S), F(S), M(S), V(S)가 표시됩니다.</p>";
      return;
    }
    this.elements["debug-content"].innerHTML = renderAiStrategyReport(debug, { includeEvaluations: true, interactive: true });
  }

  showGameOver() {
    const topScore = this.game.finalRanking[0]?.score;
    const winners = this.game.finalRanking.filter((player) => player.score === topScore);
    this.elements["winner-copy"].textContent = winners.length > 1
      ? `${winners.map((player) => player.name).join(", ")} 공동 승리!`
      : `${winners[0].name}님의 왕국이 가장 번영했습니다.`;
    this.elements["final-ranking"].innerHTML = this.game.finalRanking.map((player, index) => `
      <div class="ranking-row"><span class="rank">${index + 1}</span><span class="player-dot" style="color:${player.color}"></span><strong>${escapeHtml(player.name)}</strong><span class="rank-score">${player.score}점</span></div>`).join("");
    if (!this.elements["game-over-dialog"].open) this.elements["game-over-dialog"].showModal();
  }
}
