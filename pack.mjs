/**
 * Creates a distributable zip for local Obsidian plugin installation.
 * Output: release/gdrive-sync.zip  (contains main.js, manifest.json, styles.css)
 *
 * Usage:  node pack.mjs
 */

import { execSync } from "child_process";
import { mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";

const RELEASE_DIR = "release";
const FILES = ["main.js", "manifest.json", "styles.css"];

// 1. Build production bundle
console.log("Building…");
execSync("node esbuild.config.mjs production", { stdio: "inherit" });

// 2. Prepare release dir
mkdirSync(RELEASE_DIR, { recursive: true });
for (const f of FILES) {
  if (existsSync(f)) {
    copyFileSync(f, join(RELEASE_DIR, f));
    console.log(`  copied ${f}`);
  }
}

// 3. Zip
const zipPath = join(RELEASE_DIR, "gdrive-sync.zip");
execSync(`cd ${RELEASE_DIR} && zip -r gdrive-sync.zip main.js manifest.json styles.css`, {
  stdio: "inherit",
});

console.log(`\nDone → ${zipPath}`);
console.log("\nTo install:");
console.log("  1. Unzip gdrive-sync.zip into <your-vault>/.obsidian/plugins/gdrive-sync/");
console.log("  2. Reload Obsidian → Settings → Community plugins → enable GDrive Sync (custom)");
