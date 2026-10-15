import fs from "node:fs";
import { test, expect } from "@playwright/test";

const tokensSource = new URL("../../../portal/tokens/", import.meta.url);

// Every info icon on the Tokens page names a guide heading. Reading anchors from source covers icons
// that render only with data ("Are you over-testing?") or inside a dialog (session details).
function tokensDocAnchors() {
  const anchors = new Set();
  for (const file of fs.readdirSync(tokensSource).filter((name) => /\.(html|js)$/.test(name))) {
    const source = fs.readFileSync(new URL(file, tokensSource), "utf8");
    for (const match of source.matchAll(/(?:data-doc-anchor="|docAnchor: ")([a-z0-9-]+)"/g)) anchors.add(match[1]);
  }
  return [...anchors];
}

test("every Tokens info icon names a section of the user guide", async ({ request }) => {
  const guide = await (await request.get("/api/telemetry/guide")).json();
  expect(guide.ok).toBe(true);
  expect(guide.title).toBe("Tokens page user guide");
  const anchors = tokensDocAnchors();
  expect(anchors).toEqual(expect.arrayContaining(["identifiable-waste", "session-details", "are-you-over-testing"]));
  for (const anchor of anchors) expect(guide.html, `guide heading for ${anchor}`).toContain(`id="${anchor}"`);
});

test("a Tokens info icon opens only its own guide section", async ({ page }) => {
  await page.goto("/tokens");
  const icon = page.locator('portal-info-icon[data-doc-anchor="identifiable-waste"]');
  await icon.click();
  const dialog = page.locator("#tokensdocmodal");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="title"]')).toHaveText("Identifiable waste");
  const content = dialog.locator('[data-slot="content"]');
  // The shared markdown stylesheet keys on .markdown; without it the guide's tables render unstyled.
  await expect(content).toHaveClass(/\bmarkdown\b/);
  await expect(content.locator("table")).toHaveCount(2);
  await expect(content).toContainText("the turn counts once");
  await expect(content.locator("h1, h2")).toHaveCount(0);
  await expect(content).not.toContainText("Before you start");
  await dialog.locator('[data-slot="close"]').click();
  await expect(icon).toHaveAttribute("aria-expanded", "false");
});
