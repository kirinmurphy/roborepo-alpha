import { test, expect } from "@playwright/test";

async function routeReadySetup(page) {
  await page.route("**/api/settings", async (route) => {
    const setup = await (await route.fetch()).json();
    setup.telemetry.enabled = true;
    setup.harnesses.active = [{ id: "claude", displayName: "Claude Code", enabled: true, confidence: "confirmed" }];
    await route.fulfill({ json: setup });
  });
}

for (const theme of ["light", "dark"]) {
  test(`tokens conditions and coverage render in ${theme}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    await page.addInitScript((value) => localStorage.setItem("portal-theme", value), theme);
    await page.route("**/api/session**", (route) => route.fulfill({ json: { found: false, findings: [], analysis_prompt: "Fictional sample session prompt", heavy_turns: [] } }));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/tokens");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#condition-report")).toBeVisible();
    await expect(page.locator("#condition-cards h3").first()).toBeVisible();
    const recent = page.getByText("Recent problem sessions", { exact: true });
    await expect(page.locator("#condition-investigate-events article").first()).not.toBeVisible();
    await recent.click();
    await expect(page.locator("#condition-investigate-events article").first()).toBeVisible();
    await expect(page.locator("#condition-investigate-events")).not.toContainText("Package configured:");
    await expect(page.locator("#condition-investigate-events")).not.toContainText("Repository:");
    await page.getByRole("region", { name: "Problem sessions" }).getByRole("button", { name: "Session details", exact: true }).first().click();
    const sessionDialog = page.locator("#tokenssession-modal");
    await expect(sessionDialog).toBeVisible();
    await expect(sessionDialog).toContainText("Observation unit");
    await expect(sessionDialog).toContainText("Next step");
    await page.screenshot({ path: `/tmp/telemetry-conditions-${theme}-session-dialog.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await expect(sessionDialog).not.toBeVisible();
    await page.locator("[data-condition-open]").first().click();
    await expect(page.locator("[data-condition-dialog]").first()).toBeVisible();
    await page.screenshot({ path: `/tmp/telemetry-conditions-${theme}-category-dialog.png`, fullPage: true });
    await expect(page.locator("[data-condition-details]").first()).toContainText("unknown");
    await expect(page.locator("[data-condition-details]").first()).toContainText("without");
    await page.locator("[data-condition-close]").first().click();
    await expect(page.locator("#condition-ledger-section")).toBeVisible();
    await expect(page.locator("#condition-mark-change")).toContainText("Mark a change");
    await page.screenshot({ path: `/tmp/telemetry-conditions-${theme}.png`, fullPage: true });
    await page.setViewportSize({ width: 720, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
    expect((await page.locator(".condition-columns").first().evaluate((element) => getComputedStyle(element).gridTemplateColumns)).trim().split(/\s+/)).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#condition-cards")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.locator("[data-condition-open]").first().click();
    expect(await page.locator("[data-condition-dialog]").first().evaluate((dialog) => dialog.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
    await page.locator("[data-condition-close]").first().click();
    await page.screenshot({ path: `/tmp/telemetry-conditions-${theme}-mobile.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("mark change records backdated scope and keeps editing history", async ({ page, request }) => {
  const demo = await (await request.get("/api/tokens/mock")).json();
  const config = await (await request.get("/api/config")).json();
  config.telemetry = { ...config.telemetry, enabled: true };
  config.machineHarnesses = [{ id: "claude", enabled: true, confidence: "confirmed" }];
  const posted = [];
  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  await routeReadySetup(page);
  await page.route("**/api/data", (route) => route.fulfill({ json: demo }));
  await page.route("**/api/telemetry/markers", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, marker: posted.at(-1) } });
  });
  await page.goto("/tokens");
  await page.locator("#condition-mark-change").click();
  await page.locator('#condition-change-form [name="title"]').fill("Reduce repeated reads");
  await page.locator('#condition-change-form [name="intent"]').selectOption("suspected");
  await page.locator('#condition-change-form [name="effective_at"]').fill("2026-06-13T12:00");
  await page.locator('#condition-change-form [type="submit"]').click();
  await expect(page.locator("#condition-change-dialog")).not.toBeVisible();
  expect(posted[0].scope).toBe("all");
  expect(posted[0].watching_kinds).toEqual(["spike", "loop", "read-warning"]);
  expect(Number.isFinite(Date.parse(posted[0].effective_at))).toBe(true);
  await page.locator("#condition-changes button").first().click();
  await page.locator('#condition-change-form [name="title"]').fill("Corrected change title");
  await page.locator('#condition-change-form [type="submit"]').click();
  await expect(page.locator("#condition-change-dialog")).not.toBeVisible();
  const original = demo.conditions.changes[0].marker;
  expect(posted[1].supersedes).toBe(original.marker_id);
  expect(posted[1].packages).toEqual(original.packages ?? []);
  expect(posted[1].skills).toEqual(original.skills ?? []);
  expect(posted[1].tags).toEqual(original.tags ?? []);
  expect(Date.parse(posted[1].effective_at)).toBe(Date.parse(original.effective_at ?? original.ts));
  // Relocating an existing change to "now" needs explicit confirmation; declining posts nothing.
  await page.locator("#condition-changes button").first().click();
  await page.locator('#condition-change-form [name="intent"]').selectOption("response");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('#condition-change-form [type="submit"]').click();
  await expect(page.locator("#condition-change-dialog")).toBeVisible();
  expect(posted).toHaveLength(2);
});


test("condition signals lead to compact session evidence", async ({ page }) => {
  await page.goto("/tokens");
  const conditions = page.locator("#condition-cards");
  await expect(conditions).toContainText("fewer read warnings");
  await expect(conditions).toContainText("more read warnings");
  await expect(conditions).toContainText("More evidence needed");
  await expect(conditions).toContainText("loops: collecting");
  await expect(conditions).toContainText("claude-opus-4-8");
  await expect(conditions).not.toContainText("Fewer with condition");
  await expect(conditions).toContainText("Cheaper");
  await expect(conditions).toContainText("More expensive");
  await page.getByRole("button", { name: "Inspect read-warning sessions with claude-opus-4-8", exact: true }).click();
  const dialog = page.locator("#condition-sessions-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("claude-opus-4-8");
  await expect(dialog).not.toContainText("gpt-5-codex");
  await expect(dialog.getByRole("button", { name: "Session details", exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // The full list is one scroll layer (the Investigate body), not a nested scroller.
  await page.getByText("Recent problem sessions", { exact: true }).click();
  const list = page.getByRole("region", { name: "Problem sessions" });
  expect(await list.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
  const allSessions = await list.getByRole("button", { name: "Session details", exact: true }).count();
  expect(allSessions).toBeGreaterThan(8);
  await expect(list).toContainText("+4 findings");
});

test("polling preserves an open comparison and a change draft", async ({ page, request }) => {
  const demo = await (await request.get("/api/tokens/mock")).json();
  const config = await (await request.get("/api/config")).json();
  config.telemetry = { ...config.telemetry, enabled: true };
  config.machineHarnesses = [{ id: "claude", enabled: true, confidence: "confirmed" }];
  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  await routeReadySetup(page);
  let version = 0;
  await page.route("**/api/data", (route) => route.fulfill({ json: { ...demo, version: String(++version) } }));
  await page.goto("/tokens");
  await page.getByRole("button", { name: "Full outcomes →", exact: true }).first().click();
  await expect.poll(() => version, { timeout: 8000 }).toBeGreaterThan(1);
  await expect(page.getByRole("dialog", { name: "Models full outcomes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "+ Mark a change", exact: true }).click();
  await page.getByLabel("What changed").fill("Keep this draft");
  const previous = version;
  await expect.poll(() => version, { timeout: 8000 }).toBeGreaterThan(previous);
  await expect(page.getByLabel("What changed")).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});


test("a delayed session response cannot overwrite the next session", async ({ page }) => {
  let firstRoute;
  await page.route("**/api/session**", async (route) => {
    if (!firstRoute) { firstRoute = route; return; }
    await route.fulfill({ json: { found: false, findings: [{ summary: "Second session evidence", hint: "Second session next step" }], analysis_prompt: "Second session", heavy_turns: [] } });
  });
  await page.goto("/tokens");
  await page.getByText("Recent problem sessions", { exact: true }).click();
  const actions = page.getByRole("region", { name: "Problem sessions" }).getByRole("button", { name: "Session details", exact: true });
  await actions.nth(0).click();
  await expect.poll(() => !!firstRoute).toBe(true);
  await page.keyboard.press("Escape");
  await actions.nth(1).click();
  await expect(page.getByRole("dialog", { name: "Session detail", exact: true })).toContainText("Second session next step");
  await firstRoute.fulfill({ json: { found: false, findings: [{ summary: "Stale first session" }], analysis_prompt: "First session", heavy_turns: [] } });
  await expect(page.getByRole("dialog", { name: "Session detail", exact: true })).not.toContainText("Stale first session");
});
