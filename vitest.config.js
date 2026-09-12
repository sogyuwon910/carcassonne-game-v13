import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 배포용 Vite 설정과 분리해 순수 게임 규칙만 빠르게 검사합니다.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
  },
});
