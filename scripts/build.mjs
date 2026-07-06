// Packages the extension into a Chrome Web Store-ready .zip. Only ships
// files the extension actually loads at runtime — dev/test scaffolding
// (`.build/`, `debug-test.html`, the sample schedule PDF, etc.) is left out.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(rootDir, "dist");
const stagingDir = path.join(distDir, "staging");

const manifest = JSON.parse(
  fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")
);

const INCLUDE = [
  "background.js",
  "parser.js",
  "parser-core.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons",
  "lib",
];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

for (const entry of INCLUDE) {
  const src = path.join(rootDir, entry);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing expected file/dir for package: ${entry}`);
  }
  fs.cpSync(src, path.join(stagingDir, entry), { recursive: true });
}

// The Chrome Web Store rejects uploads whose manifest has a "key" field
// (that field is only for side-loaded/enterprise extensions, and is used
// locally here to keep the unpacked dev extension's ID — and therefore its
// OAuth redirect URI — stable across reloads). Strip it for the store zip;
// the Store assigns its own ID on first upload.
const { key, ...manifestForStore } = manifest;
fs.writeFileSync(
  path.join(stagingDir, "manifest.json"),
  JSON.stringify(manifestForStore, null, 2) + "\n"
);

const zipName = `setters-scheduler-v${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);

execFileSync("zip", ["-r", "-X", path.join("..", zipName), "."], {
  cwd: stagingDir,
  stdio: "inherit",
});

fs.rmSync(stagingDir, { recursive: true, force: true });

const { size } = fs.statSync(zipPath);
console.log(`\nBuilt ${path.relative(rootDir, zipPath)} (${(size / 1024).toFixed(1)} KB)`);
