// Helpers shared by portal UI specs: registering fixture repositories with the hermetic server, and
// patching Home's overview so a test states only the domain data it depends on.
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

export async function portalToken(page) {
  await page.goto("/plans");
  return page.locator("meta[name=cli-portal-token]").getAttribute("content");
}

export async function addRepositorySource(page, sourcePath) {
  const response = await page.request.post("/api/repositories/sources", {
    headers: { "X-Cli-Portal-Token": await portalToken(page) },
    data: { path: sourcePath },
  });
  expect(response.ok()).toBe(true);
}

// The repositories a removed source found stay registered (removal never deletes a repository),
// which is harmless here: each fixture is its own repository, and removeFixtureContents keeps it
// out of later specs' Home.
export async function removeRepositorySources(page) {
  const token = await portalToken(page);
  const { sources } = await (await retryingReset(() => page.request.get("/api/repositories/sources"))).json();
  for (const source of sources) {
    const response = await page.request.post(`/api/repositories/sources/${source.id}/remove`, { headers: { "X-Cli-Portal-Token": token } });
    expect(response.ok()).toBe(true);
  }
}

// Empties a plan fixture but keeps its root. A registered checkout whose parent folder is gone reads
// as unreadable, which Home keeps listing; with the parent present it reads as absent and leaves Home.
//
// The portal can still be running Git in a fixture's plans worktree (a refresh started before the
// source was removed), and Git writes into `.git/worktrees/<name>` while the removal walks it. rmSync's
// own retries cover a few hundred milliseconds; a slow runner needs the whole removal retried until
// that Git work finishes.
const REMOVE_SETTLE_MS = 15_000;
const TRANSIENT_REMOVE_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

export function removeFixtureContents(fx) {
  const deadline = Date.now() + REMOVE_SETTLE_MS;
  for (const entry of fs.readdirSync(fx.tmp)) {
    const target = path.join(fx.tmp, entry);
    for (;;) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        break;
      } catch (err) {
        if (!TRANSIENT_REMOVE_CODES.has(err?.code) || Date.now() > deadline) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  }
}

// The Plans board only shows once plan-suite is enabled; the hermetic machine has no packages.
export async function enablePlanBoard(page) {
  await page.route(/\/api\/plans(\/refresh)?(\?|$)/, async (route) => {
    const data = await (await retryingReset(() => route.fetch())).json();
    data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
    await route.fulfill({ json: data });
  });
}

// The Backlog list holding a plan: Backlog is a repo and namespace directory, so its cards sit behind
// a URL that names both. A repo with no plans-config.json lists everything under No namespace.
export async function backlogUrlFor(page, planTitle) {
  const { plans, backlog } = await (await retryingReset(() => page.request.get("/api/plans"))).json();
  const record = plans.find((item) => item.plan.title === planTitle);
  const entry = backlog.find((item) => item.repositoryId === record.repository.repositoryId);
  return `/plans?lifecycle=backlog&repo=${entry.urlKey}&namespace=${record.plan.namespace || "_none"}`;
}

// Serves the real /api/home response passed through `mutate`, for both Home and the Plans page
// (which reads the same overview).
export async function patchHomeOverview(page, mutate) {
  await page.route("**/api/home", async (route) => {
    const data = await (await retryingReset(() => route.fetch())).json();
    mutate(data);
    await route.fulfill({ json: data });
  });
}

// A GET can land on a keep-alive socket the portal is closing as idle, which fails with ECONNRESET
// (or "socket hang up") before the server reads the request, so one retry on a fresh connection is
// safe.
async function retryingReset(request) {
  try {
    return await request();
  } catch (error) {
    if (!/ECONNRESET|socket hang up/.test(error?.message || "")) throw error;
    return request();
  }
}

export function roboRepoCard(page) {
  return page.locator(".repository-card").filter({ has: page.getByRole("heading", { name: "RoboRepo", exact: true }) }).first();
}

export function planRowOf(card, title) {
  return card.locator(".repository-root").filter({ has: card.page().getByRole("button", { name: title, exact: true }) });
}
