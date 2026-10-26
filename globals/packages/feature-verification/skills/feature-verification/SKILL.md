---
name: feature-verification
description: Use when completing or demonstrating a change whose behavior the user should see proven — "show me it works", "prove it", "screenshot", "recording", "demo the change", or when a UI, server, API, CLI, or performance change needs evidence beyond existing checks. Picks the fastest sufficient evidence (executed checks, command or request output, measured numbers, browser screenshots or recordings through `roborepo browser`), runs safe verification itself instead of handing it to the user, and shows that evidence in the conversation (screenshots inline, the steps taken, what passed versus what was only observed). Do not use for routine test-result reporting when existing checks already establish the outcome, choosing or running a repo's tests (test-harness), and do not use for questions or plans where nothing was built.
---

# Feature Verification

Show the user that finished work behaves as claimed, with evidence they can open. Do the safe
verification yourself; hand a check to the user only when it truly needs them.

`test-harness` chooses and runs the repo's tests. This skill decides what evidence the user sees and
puts it in front of them: the picture, the steps taken, and what passed.

Reporting existing test results alone does not trigger this skill. Reuse evidence already
produced; load this guidance when selecting or capturing additional behavioral evidence.

## Choose the fastest sufficient evidence

Reuse what relevant testing already produced. Do not rerun passing work just to make it look
better, and do not capture anything decorative.

| Change or question | Default evidence | Use more when |
| --- | --- | --- |
| Static UI | One screenshot, or before/after frames (`roborepo browser run`) | Other states matter |
| Interactive UI | Key frames; a short recording if sequence or motion matters | Stills cannot show the behavior |
| Browser failure | The failure and a selective screenshot | A trace is needed to diagnose it |
| Server, API, CLI | The executed command or request and its output, plus test results, run directly | An unexpected result needs diagnosis |
| Architecture / workflow | A diagram: the inline visual tool in chat, Mermaid in files | Alternatives or tradeoffs need context |
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
  paths), and `limitations`. Report the status exactly; never upgrade `unverified` to passed. A
  `passed`, `failed`, or `blocked` run gets a `Verified: roborepo browser run … -> pass|fail|blocked`
  line. An `unverified` run asserted nothing, so it gets no `Verified:` line: report what it
  showed as observed.
- For test files, screenshots and video follow the project's Playwright config; ask for `trace`
  only to diagnose a failure, since traces hold page and network state.
- Plan capture before running: a recording must be requested up front, and finalizes only when the
  browser context closes.

### When Playwright is missing

A `blocked` result names the exact install command. It installs the Playwright package into
RoboRepo's tool directory, never the project's `package.json` or lockfile, and the browser into
Playwright's shared per-user cache. Run it only through the harness's normal permission
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

## Make the verification visible

The user does not see your tool calls. Browser, computer-use, and shell work that happened out of
sight did not happen as far as they can tell, so the report has to show it.

- **Show the picture.** Put the primary screenshot or recording in the conversation with the
  harness's file-sharing or image tool, rendered inline. A path alone is not evidence the user can
  see. If this session cannot display files, say so, describe what the frame shows, and give the
  path. Never invent a URL.
- **Name the walk-through** in one line, in the user's terms: "Opened Settings → turned on dark mode
  → reloaded → still dark." This applies to every browser or desktop tool, including the harness's
  own browser pane, Chrome, and desktop control, not only `roborepo browser`.
- **Before/after** for a visual change: two frames side by side, or one visual comparing them.
- **Output, trimmed:** for a command or request, show the few lines that prove the point in a fenced
  block, not the whole log.
- One primary evidence item; add secondary artifacts only when they show something new. Evidence
  under `~/.roborepo/browser/evidence/` is kept 14 days and pruned when a later run starts.

## Completion responses

A one-line result, the evidence shown, then what needs the user. Use the user's words for
the feature, not file or function names they have not seen. Code-level detail waits until asked.

```text
Search now filters as you type.

[screenshot shown inline]
Opened the shop page → typed "tea" → list narrowed to 2 items

✓ Browser check passed (2/2)
◎ Empty-search state seen in the screenshot, not asserted

Nothing needs you. Want the code-level detail?
```

| Before | After |
| --- | --- |
| "I updated `SearchList.tsx` to debounce input and refactored the filter hook. Please run the app and check the search box." | The block above. |
| "The tests should pass now." | "✓ Search tests pass (14). ◎ The empty-query state was only seen in a screenshot, not asserted." |
| "Investigated the 500s — it's probably the cache." | "The errors happen on the first request after a restart, then stop once the cache warms up. Reproduced: first call 500, second call 200. Not fixed yet." |
| "I looked at a few ways to store sessions and went with Redis, then wired up the client, added a pool, and updated the config loader." | "Logins need storage that survives restarts. Your call: Redis (fast, one more service to run) or Postgres (already running, ~5 ms slower, measured locally). I'd pick Postgres. Nothing built yet." |
| "Running tests… reading `auth.ts`… editing `auth.ts`… running tests again…" | "Login works with the new token format; token refresh is next." |

Exact `Verified: <command> -> <pass|fail|blocked>` lines, when required, go in one block at the end,
after this plain-language report.
