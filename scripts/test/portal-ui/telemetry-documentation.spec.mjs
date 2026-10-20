import fs from "node:fs";
import path from "node:path";
import { documentationScenario } from "../fixtures/telemetry-conditions-documentation.mjs";
import { test, expect } from "@playwright/test";

const destination = process.env.TELEMETRY_DOC_SCREENSHOTS;
test.use({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1440, height: 1050 } });
for (const theme of ["light", "dark"]) {
  test(`documentation screenshots: ${theme}`, async ({ page, request }) => {
    test.skip(!destination, "Set TELEMETRY_DOC_SCREENSHOTS to regenerate documentation images");
    fs.mkdirSync(destination, { recursive: true });
    const { report } = documentationScenario();
    const config = await (await request.get("/api/config")).json();
    config.telemetry = { ...config.telemetry, enabled: true };
    config.machineHarnesses = [{ id: "claude", enabled: true, confidence: "confirmed" }];
    await page.route("**/api/config", (route) => route.fulfill({ json: config }));
    await page.route("**/api/data", (route) => route.fulfill({ json: report }));
    // This fixture never writes a marker or uses personal telemetry.
    await page.route("**/api/telemetry/markers", (route) => route.abort());
    await page.route("**/api/telemetry/oracle-health", (route) => route.fulfill({ json: oracleHealthSample() }));
    await page.addInitScript((value) => localStorage.setItem("portal-theme", value), theme);
    await page.goto("/tokens");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#condition-report")).toBeVisible();
    // Sticky section heads and the portal header would paint over the top of an element screenshot.
    await page.addStyleTag({ content: ".t2-sec-head, .portal-header { position: static !important; margin-top: 0 !important; }" });
    const capture = async (locator, name) => {
      await locator.scrollIntoViewIfNeeded();
      await locator.screenshot({ path: path.join(destination, `${name}-${theme}.png`), animations: "disabled" });
    };
    await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Passed");
    await capture(page.locator(".t2-report-meta"), "oracle-health");
    await page.getByRole("button", { name: "Oracle health details" }).click();
    const oracleDialog = page.getByRole("dialog", { name: "Oracle health details" });
    await expect(oracleDialog).toContainText("26 events · 26 sessions");
    await capture(oracleDialog, "oracle-health-detail");
    await oracleDialog.getByRole("button", { name: "Close" }).click();
  });
}

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

test("Oracle guide screenshots are served by the portal", async ({ request }) => {
  const guide = await (await request.get("/api/telemetry/guide")).json();
  const images = [...guide.html.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]);
  expect(images).toHaveLength(2);
  for (const image of images) {
    const response = await request.get(image);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
});

// Fictional, fixed oracle health so the badge and its details render identically on every capture.
// Counts match the documentation report's 26 single-event sessions shown in the header beside it.
function oracleHealthSample() {
  return {
    schema: 1, status: "passed", checked_at: "2026-09-04T03:20:00.000Z", duration_ms: 292,
    evidence_signature: `sha256:${"0".repeat(64)}`, event_count: 26, session_count: 26, operation_count: 26,
    coverage: { supported_events: 26, unsupported_events: 0, comparable: true, complete: true, issues: [],
      checks: ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"] },
    differences: [], summary: "Production and oracle calculations agree for the checked supported evidence.",
  };
}
