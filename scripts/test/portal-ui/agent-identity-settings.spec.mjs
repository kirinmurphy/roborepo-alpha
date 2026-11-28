// The agent account rows on Settings: one row per Git host provider with an agent account that the
// server lists. GitHub's row ("Agent GitHub account") switches the `github-agent-identity` package;
// a second provider, as the server would list one, gets its own row with its own label, and its
// switch names its own package. The server side is covered by repository-agent-identity-check.mjs,
// so these tests answer its routes with fixed reports.
import { test, expect } from "@playwright/test";

const GITHUB = { id: "github", displayName: "GitHub", hosts: ["github.com"], capabilities: ["repository", "agent-identity", "branch-protection", "pull-requests"], packageId: "github-agent-identity" };
const FAKE = { id: "fake", displayName: "Fake Forge", hosts: ["forge.example.test"], capabilities: ["repository", "agent-identity"], packageId: "fake-agent-identity" };

const report = (overrides) => ({
  state: "healthy", botLogin: "robo-bot", savedLogin: "robo-bot", signedIn: true, packageEnabled: true,
  expiresAt: "2027-02-20T12:00:00.000Z", scopes: [], reason: null, findings: [], enableOffered: false, offerDismissed: false, ...overrides,
});
const ready = report({ packageEnabled: false, enableOffered: true });

// Lists `providers`, answers each provider's account read from `accounts[id]`, and records the
// enable posts (by provider) and the package switches.
async function stub(page, { providers, accounts }) {
  const enables = [];
  const switches = [];
  await page.route(/\/api\/forge-providers(\?.*)?$/, (route) => route.fulfill({ json: providers }));
  await page.route(/\/api\/agent-identity(\/enable)?(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("provider");
    if (route.request().method() === "POST") {
      enables.push(id);
      accounts[id] = report({ packageEnabled: true });
      return route.fulfill({ json: { enabled: true, account: accounts[id] } });
    }
    return route.fulfill({ json: accounts[id] });
  });
  await page.route("**/api/config/packages", (route) => {
    const body = JSON.parse(route.request().postData());
    switches.push(body);
    const provider = providers.find((entry) => entry.packageId === body.id);
    accounts[provider.id] = { ...ready };
    return route.fulfill({ json: { ok: true } });
  });
  return { enables, switches };
}

test.describe("Agent account rows on Settings", () => {
  test("GitHub alone: one Agent GitHub account row whose switch turns github-agent-identity on and off", async ({ page }) => {
    const { enables, switches } = await stub(page, { providers: [GITHUB], accounts: { github: { ...ready } } });
    await page.goto("/settings");
    const rows = page.locator(".agent-identity-row");
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Agent GitHub Account" })).toBeVisible();
    const row = page.getByRole("group", { name: "Agent GitHub account" });

    await row.getByRole("button", { name: "Turn on" }).click();
    await expect(row.getByRole("status")).toHaveText(/^robo-bot · token expires /);
    expect(enables).toEqual(["github"]);

    await row.getByRole("button", { name: "Turn off" }).click();
    await expect(row.getByRole("status")).toHaveText("robo-bot is ready; agents act as you.");
    expect(switches).toEqual([{ id: "github-agent-identity", enabled: false }]);
  });

  test("a second provider the server lists gets its own row, label, and package", async ({ page }) => {
    const { enables, switches } = await stub(page, {
      providers: [GITHUB, FAKE],
      accounts: { github: report({}), fake: report({}) },
    });
    await page.goto("/settings");
    await expect(page.locator(".agent-identity-row")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Agent Accounts" })).toBeVisible();
    const github = page.getByRole("group", { name: "Agent GitHub account" });
    const fake = page.getByRole("group", { name: "Agent Fake Forge account" });
    await expect(github).toBeVisible();
    await expect(fake).toBeVisible();
    await expect(fake).toContainText("a separate Fake Forge account");

    await fake.getByRole("button", { name: "Turn off" }).click();
    await expect(fake.getByRole("button", { name: "Turn on" })).toBeVisible();
    expect(switches).toEqual([{ id: "fake-agent-identity", enabled: false }]);
    // GitHub's row is untouched by the other provider's switch.
    await expect(github.getByRole("button", { name: "Turn off" })).toBeVisible();

    await fake.getByRole("button", { name: "Turn on" }).click();
    await expect(fake.getByRole("button", { name: "Turn off" })).toBeVisible();
    expect(enables).toEqual(["fake"]);
  });
});
