import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  charset: "utf8",
  legalComments: "none",
};

await build({
  ...common,
  entryPoints: ["src/background.ts"],
  outfile: "dist/background.js",
});

await build({
  ...common,
  entryPoints: ["src/content.ts"],
  outfile: "dist/content.js",
});

await build({
  ...common,
  entryPoints: ["src/viewer/viewer.ts"],
  outfile: "dist/viewer.js",
});

copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("src/viewer/viewer.html", "dist/viewer.html");
copyFileSync("src/popup/popup.html", "dist/popup.html");
console.log("build ok -> dist/");
