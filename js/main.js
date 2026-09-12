import { BoardRenderer } from "./renderer.js";
import { parseTileDefinitions } from "./tile.js";
import { GameUI } from "./ui.js";

async function boot() {
  const loading = document.querySelector("#loading-screen");
  const start = document.querySelector("#start-screen");
  try {
    const response = await fetch("/assets/data/tiles.json");
    if (!response.ok) throw new Error(`타일 데이터를 불러오지 못했습니다 (${response.status}).`);
    const definitions = parseTileDefinitions(await response.json());
    const renderer = new BoardRenderer(document.querySelector("#board-canvas"), {
      onMessage: (message) => {
        const toast = document.querySelector("#board-toast");
        toast.textContent = message;
        toast.classList.add("is-visible");
        setTimeout(() => toast.classList.remove("is-visible"), 1800);
      },
    });
    await renderer.preload(definitions);
    const ui = new GameUI(definitions, renderer);
    renderer.onGameAction = () => ui.handleManualBoardAction();
    loading.classList.add("is-hidden");
    start.classList.remove("is-hidden");
  } catch (error) {
    loading.innerHTML = `<div class="loading-error"><strong>게임을 시작할 수 없습니다.</strong><p>${error.message}</p><small>VSCode Live Server로 index.html을 실행했는지 확인해 주세요.</small></div>`;
    console.error(error);
  }
}

boot();
