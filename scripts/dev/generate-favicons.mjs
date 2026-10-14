#!/usr/bin/env node
// Regenerates the PNG icons in portal/shared/favicon/ from their SVG sources: favicon.svg (tab icon,
// transparent, glyph-only) and app-icon.svg (the robot on a dark tile).
//
// Usage: node scripts/dev/generate-favicons.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { repoRoot } from "../cli/paths.mjs";

const dir = path.join(repoRoot, "portal", "shared", "favicon");

// Filename → [source svg, pixel size]. 32 is the tab fallback for browsers without SVG icon
// support, 180 the iOS home-screen icon, 192/512 the sizes web-app manifests expect.
const ICONS = {
  "favicon-32.png": ["favicon.svg", 32],
  "apple-touch-icon.png": ["app-icon.svg", 180],
  "icon-192.png": ["app-icon.svg", 192],
  "icon-512.png": ["app-icon.svg", 512],
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [name, [source, size]] of Object.entries(ICONS)) {
    const svg = fs.readFileSync(path.join(dir, source), "utf8");
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: path.join(dir, name), omitBackground: true });
    console.log(`wrote ${path.relative(repoRoot, path.join(dir, name))}`);
  }
} finally {
  await browser.close();
}
