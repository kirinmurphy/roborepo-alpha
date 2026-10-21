---
name: feature-verification
description: Use when completing or demonstrating a change whose behavior the user should see proven — "show me it works", "prove it", "screenshot", "recording", "demo the change", or any completion report for a UI, server, API, CLI, or performance change. Picks the fastest sufficient evidence (executed checks, command or request output, measured numbers, browser screenshots or recordings through `roborepo browser`), runs safe verification itself instead of handing it to the user, and reports what passed versus what was only observed. Do not use for choosing or running a repo's tests (test-harness), and do not use for questions or plans where nothing was built.
---

# Feature Verification

Show the user that finished work behaves as claimed, with evidence they can open. Do the safe
verification yourself; hand a check to the user only when it truly needs them.

`test-harness` chooses and runs the repo's tests. This skill decides what evidence the user sees and
reports it with the same `Verified: <command> -> <pass|fail|blocked>` line.

## Choose the fastest sufficient evidence

Reuse what relevant testing already produced. Do not rerun passing work just to make it look
better, and do not capture anything decorative.

| Change or question | Default evidence | Use more when |
| --- | --- | --- |
| Static UI | One screenshot, or before/after frames (`roborepo browser run`) | Other states matter |
| Interactive UI | Key frames; a short recording if sequence or motion matters | Stills cannot show the behavior |
| Browser failure | The failure and a selective screenshot | A trace is needed to diagnose it |
| Server, API, CLI | The executed command or request and its output, plus test results, run directly | An unexpected result needs diagnosis |
| Architecture / workflow | Mermaid, when relationships are hard to explain in prose | Alternatives or tradeoffs need context |
| Performance | Measured before/after values | A chart shows the trend better |
| Simple or nonvisual work | A brief result and proportionate checks | A material question remains |

Shell, API, and test evidence run through the normal shell (`curl`, the command, the test runner).
Only the browser needs `roborepo browser`.

## What evidence proves

- **Passed** means an executed assertion passed: a test, a `check()` in a browser scenario, a command
  whose output was compared to an expectation.
- A screenshot or recording shows **observed** behavior. It is not proof of correctness.
- A diagram or example only **illustrates**. It never shows that code ran.
- Say plainly when verification was **unavailable**, and why.

## Browser evidence

```sh
roborepo browser probe --json
roborepo browser run --scenario <path> [--capture screenshot,video,trace] [--url <url>] [--serve "<dev command>"] --json
```

- `probe` reports whether Playwright and Chromium are reachable and what can be captured. It never
  installs or launches anything.
- `--scenario` is the project's own Playwright test file (`*.spec.*`, `*.test.*`, preferred: its
  assertions already exist) or a JavaScript script:

  ```js
  export default async function ({ page, url, check, screenshot }) {
    await page.goto(url);
    await check("results filter while typing", async () => {
      await page.getByRole("searchbox").fill("tea");
      if ((await page.getByRole("listitem").count()) !== 2) throw new Error("expected 2 results");
    });
    await screenshot();
  }
  ```

  A script earns `passed` only through `check()`. Without one the run is `unverified`.
- Results: `status` (`passed`, `failed`, `unverified`, `blocked`), `checks`, `artifacts` (real file
  paths), and `limitations`. Report the status exactly; never upgrade `unverified` to passed.
- For test files, screenshots and video follow the project's Playwright config; ask for `trace`
  only to diagnose a failure, since traces hold page and network state.
- Plan capture before running: a recording must be requested up front, and finalizes only when the
  browser context closes.

### When Playwright is missing

A `blocked` result names the exact install command. It installs into RoboRepo's tool directory,
never the project's `package.json` or lockfile. Run it only through the harness's normal permission
prompt. If the user declines, the result stays `blocked`: fall back to other evidence and say so.

## Run safely

1. **Reuse first.** Look for a running app (`roborepo runtime --json` when auto-discovery is on), the
   project's tests, and evidence already produced. If that is enough, launch nothing.
2. **Start only when justified,** with the project's established dev command and known local URL
   (`--url` with `--serve`). The command stops only what it started. Never stop a service that was
   already running, and never use Runtime's stop action for a service you did not start.
3. **Verify and capture together** in one run, with the smallest useful artifact.
4. **Fall back truthfully.** A missing tool, unreachable app, or unasserted behavior is stated as
   such, with whatever real test or command evidence exists.

Never guess production URLs or deployments. Never purchase, send, publish, or change anything
external to stage evidence. Prefer fixtures and mock data, keep capture narrow, and keep
credentials, tokens, and private data out of frame.

## Deliver it

- Lead with one primary evidence item; mention secondary artifacts only if they add something.
- Give exact paths. Evidence lives under `~/.roborepo/browser/evidence/` for 14 days; it is pruned
  only when a later run starts.
- Before calling evidence viewable, confirm this session can show or open the file. If it cannot,
  give a real text summary and say the artifact is local. Never invent a URL.

## Completion responses

Short and outcome-first: the result, the best available evidence, and what needs attention. Add
architecture detail only when a decision, uncertainty, or risk needs the user's judgment.

| Before | After |
| --- | --- |
| "I updated `SearchList.tsx` to debounce input and refactored the filter hook. Please run the app and check the search box." | "Search now filters while typing. Browser checks passed (2/2); screenshot: `…/20261021T…-1-screenshot.png`. Nothing needs your attention." |
| "The tests should pass now." | "`Verified: npm test -- search -> pass` (14 tests). The empty-query state was only observed in a screenshot, not asserted." |
| "Investigated the 500s — it's probably the cache." | "The 500s come from a cache miss on cold start: reproduced with `curl -i localhost:3000/api/items` (500) after restart, then 200 once warm. Not yet fixed." |
