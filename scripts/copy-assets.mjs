import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const distAssets = resolve("dist/assets");
await mkdir(distAssets, { recursive: true });

await cp(resolve("assets/data"), resolve("dist/assets/data"), {
  recursive: true,
  force: true
});

await cp(resolve("assets/tiles"), resolve("dist/assets/tiles"), {
  recursive: true,
  force: true
});

console.log("Copied assets/data and assets/tiles into dist/assets without deleting Vite bundles.");
