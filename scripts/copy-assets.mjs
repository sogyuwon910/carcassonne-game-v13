import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("assets");
const target = resolve("dist/assets");

await mkdir(resolve("dist"), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log("Copied assets/ -> dist/assets/");
