#!/usr/bin/env node
// `doctor --installed` hint lines for hook readiness: one line per harness whose RoboRepo hooks
// will not all run, with the next step. Advisory only, so it always exits 0; doctor prints each
// line through its non-failing hint helper.

import fs from "node:fs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { readinessSupported } from "../harnesses/hook-readiness.mjs";
import { harnessHome } from "./paths.mjs";
import { loadHookReadiness } from "./hook-readiness-status.mjs";
import { hookReadinessLines } from "./hook-review-guidance.mjs";

for (const provider of listHarnessProviders()) {
  if (!fs.existsSync(harnessHome[provider.id] || "") || !readinessSupported(provider.id)) continue;
  let readiness;
  try { readiness = await loadHookReadiness(provider.id); } catch { continue; }
  for (const line of hookReadinessLines(readiness)) console.log(line);
}
