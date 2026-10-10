import { test, expect } from "@playwright/test";
import { documentationScenario } from "../fixtures/telemetry-conditions-documentation.mjs";

const checks = ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"];
const labels = { passed: "Passed", checking: "Checking", stale: "Stale", partial: "Partial",
  unavailable: "Unavailable", failed: "Failed" };

test("oracle health exposes every text status and an accessible singleton dialog", async ({ page }) => {
  let status = "checking";
  await page.route("**/api/telemetry/oracle-health", (route) => route.fulfill({ json: health(status) }));
  for (const next of Object.keys(labels)) {
    status = next;
    await page.goto("/tokens");
    const badge = page.getByRole("status", { name: "Oracle health" });
    await expect(badge).toHaveText(`Oracle health: ${labels[next]}`);
    await expect(badge).toHaveAttribute("data-status", next);
  }

  status = "failed";
  await page.goto("/tokens");
  const open = page.getByRole("button", { name: "Oracle health details" });
  await expect(open).toHaveAttribute("aria-haspopup", "dialog");
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  const dialog = page.getByRole("dialog", { name: "Oracle health details" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Independent recomputation");
  await expect(dialog).toContainText("2 events");
  await expect(dialog).toContainText("2 supported · 0 unsupported");
  await expect(dialog).toContainText("Condition comparisons");
  await expect(dialog).toContainText("Disagreement in: condition comparisons.");
  await expect(dialog).not.toContainText("PRIVATE");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  await dialog.getByRole("button", { name: "Read the Oracle health guide" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(open).toHaveAttribute("aria-expanded", "false");
  const guide = page.getByRole("dialog", { name: "Tokens page user guide" });
  await expect(guide).toBeVisible();
  await expect(guide.locator("#oracle-health")).toBeVisible();
  await guide.getByRole("button", { name: "Close" }).click();
});

test("oracle polling updates independently and endpoint failure leaves the report usable", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/telemetry/oracle-health", (route) => {
    requests += 1;
    return requests === 1 ? route.fulfill({ json: health("checking") }) : route.fulfill({ json: health("passed") });
  });
  await page.goto("/tokens");
  await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Checking");
  await expect(page.locator("#findings")).not.toBeEmpty();
  await page.evaluate(() => { window.__oracleReportNode = document.querySelector("#findings").firstElementChild; });
  await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Passed", { timeout: 8_000 });
  expect(await page.evaluate(() => window.__oracleReportNode === document.querySelector("#findings").firstElementChild)).toBe(true);
  // The demo report has no live evidence to change, so polling stops at the first settled status.
  const settledRequests = requests;
  await page.waitForTimeout(6_000);
  expect(requests).toBe(settledRequests);

  await page.unroute("**/api/telemetry/oracle-health");
  await page.route("**/api/telemetry/oracle-health", (route) => route.abort());
  await page.reload();
  await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Unavailable");
  await expect(page.getByRole("heading", { name: "Identifiable waste" })).toBeVisible();
});

test("live telemetry keeps polling oracle health after a settled status", async ({ page }) => {
  await page.route("**/api/settings", async (route) => {
    const setup = await (await route.fetch()).json();
    setup.telemetry.enabled = true;
    setup.harnesses.active = [{ id: "claude", displayName: "Claude Code", enabled: true, confidence: "confirmed" }];
    await route.fulfill({ json: setup });
  });
  await page.route("**/api/data", (route) => route.fulfill({ json: documentationScenario().report }));
  await page.route("**/api/telemetry/markers", (route) => route.abort());
  let requests = 0;
  await page.route("**/api/telemetry/oracle-health", (route) => {
    requests += 1;
    return route.fulfill({ json: health(requests === 1 ? "passed" : "stale") });
  });
  await page.goto("/tokens");
  await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Passed");
  await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Stale", { timeout: 8_000 });
});

test("oracle health remains legible across themes, forced colors, and mobile", async ({ page }) => {
  await page.route("**/api/telemetry/oracle-health", (route) => route.fulfill({ json: health("passed") }));
  for (const theme of ["light", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("portal-theme", value), theme);
    await page.goto("/tokens");
    const badge = page.getByRole("status", { name: "Oracle health" });
    await expect(badge).toHaveText("Oracle health: Passed");
    const colors = await badge.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    });
    expect(colors.color).not.toBe(colors.background);
    expect(colors.border).not.toBe("rgba(0, 0, 0, 0)");
  }
  await page.emulateMedia({ forcedColors: "active" });
  await page.reload();
  await expect(page.getByRole("status", { name: "Oracle health" })).toHaveText("Oracle health: Passed");
  expect(await page.getByRole("status", { name: "Oracle health" }).evaluate((element) => getComputedStyle(element).borderStyle)).toBe("solid");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Oracle health details" }).click();
  const dialog = page.getByRole("dialog", { name: "Oracle health details" });
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

function health(status) {
  const checked = !["checking", "unavailable"].includes(status);
  return {
    schema: 1, status,
    checked_at: checked ? "2026-10-01T18:22:31.000Z" : null,
    duration_ms: checked ? 347 : null,
    evidence_signature: checked ? `sha256:${"a".repeat(64)}` : null,
    event_count: checked ? 2 : 0,
    session_count: checked ? 1 : 0,
    operation_count: checked ? 1 : 0,
    coverage: { supported_events: checked ? 2 : 0, unsupported_events: 0,
      comparable: checked, complete: status === "passed", issues: [], checks: checked ? checks : [] },
    differences: status === "failed" ? ["conditions"] : [],
    summary: `${labels[status]} privacy-safe summary.`,
  };
}
