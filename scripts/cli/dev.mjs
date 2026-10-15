// Development-checkout-only tooling. Everything here operates on `local/`, which package.json's
// `files` never publishes — so in an npm install the scripts these commands drive do not exist.
//
// WHY A GATE IS STILL NEEDED: manifests/ DOES ship. The command definitions for `roborepo dev *`
// therefore reach an npm user even though local/ does not, and without a check they would fail with
// a bare `missing script:` path error. requireDevelopmentCheckout() turns that into a clear
// statement of why the command is unavailable.
//
// NOT THE SAME AS `kind: "internal"`. That flag is about VISIBILITY — internal commands are hidden
// from menus and help but still run fine on end-user machines (`setup`, `bundle`, `onboard-intro`
// are all install-time commands that must). This module is about AVAILABILITY: these commands
// cannot work off a dev checkout at all. Orthogonal axes; easy to conflate.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, requireDevelopmentCheckout, stateRoot } from "./paths.mjs";
import { setDevFixturesEnabled } from "../../modules/repositories/index.mjs";
import { serveCommand, webStopCommand } from "./telemetry.mjs";

const FIXTURE_SCRIPT = path.join("local", "dev-fixtures", "developer-runtime-test-data.mjs");
const FIXTURE_ACTIONS = new Set(["start", "stop", "status"]);

// The fixture runs as a child process rather than an import: it is a standalone script under
// local/ with its own CLI contract, and shelling out keeps that contract the single entrypoint
// whether a human or this orchestrator invokes it.
function runFixture(action) {
  requireDevelopmentCheckout(FIXTURE_SCRIPT);
  const script = path.join(repoRoot, FIXTURE_SCRIPT);
  if (!fs.existsSync(script)) {
    console.error(`missing dev fixture script: ${script}`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [script, action], { stdio: "inherit" });
  if (result.error) {
    console.error(`failed to run the dev fixture: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

export function devFixtureCommand(args) {
  const action = args[0] || "status";
  if (!FIXTURE_ACTIONS.has(action)) {
    console.error("usage: roborepo dev fixture <start|stop|status>");
    process.exit(2);
  }
  process.exit(runFixture(action));
}

// `dev start`/`dev stop` orchestrate the dev environment by calling the SAME commands a human
// would — the fixture script and `web`/`web stop`. There is deliberately no `dev portal` wrapper:
// `web --detach` now adopts a healthy portal instead of killing it, so a wrapper would add nothing
// but a second place for port logic to drift out of sync.
// Every branch propagates the fixture's exit status. Dropping it made a failed teardown invisible
// to scripts: `dev stop` printed "could not stop the stack" and still exited 0, so a
// stop-then-start loop would rebuild against a stack still holding its port.
export async function devCommand(args) {
  requireDevelopmentCheckout("roborepo dev");
  const action = args[0] || "status";
  const rest = args.slice(1);

  if (action === "start") {
    // Bail before the portal when the fixture fails: `dev start` promises a working environment,
    // and a portal rendering a stack that never came up is worse than a clear failure.
    const status = runFixture("start");
    if (status !== 0) process.exit(status);
    // Fixture repositories show in the portal only while dev mode is on; `dev stop` turns it off.
    setDevFixturesEnabled({ stateRoot, enabled: true });
    await serveCommand([...rest, "--detach", "--no-open"]);
    return;
  }
  if (action === "stop") {
    // Portal first: it is the process that holds a port, so stopping it before tearing down the
    // fixture avoids a window where the portal renders a stack that is already gone.
    webStopCommand(rest);
    setDevFixturesEnabled({ stateRoot, enabled: false });
    // Unlike start, the fixture still runs even if the portal stop reported trouble — a teardown
    // should tear down as much as it can rather than stopping at the first failure.
    process.exit(runFixture("stop"));
  }
  if (action === "status") {
    process.exit(runFixture("status"));
  }
  console.error("usage: roborepo dev <start|stop|status>");
  process.exit(2);
}
