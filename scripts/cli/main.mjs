#!/usr/bin/env node
// roborepo CLI composition root. Command/menu/help metadata lives in the command catalog;
// command behavior stays in focused sibling modules.

import { loadCommandCatalog } from "./command-catalog.mjs";
import { executeCommand, validateExecutions } from "./command-executor.mjs";
import { resolveCommand } from "./command-resolver.mjs";
import { shouldRouteToInit } from "./first-run-routing.mjs";
import { renderHelp } from "./help-renderer.mjs";
import { runInteractiveMenu } from "./interactive-menu.mjs";
import { refreshAppRootRecord } from "./state-paths.mjs";
import { sanitizeWriteActor } from "./write-log.mjs";

refreshAppRootRecord();

// --no-presets-onboard used to opt out of a forced onboarding pass that ran before dispatch. That
// gate is gone (first-run routing below replaces it), but the flag stays accepted-and-ignored so
// existing scripts and shell aliases carrying it keep working instead of failing on an unknown flag.
const argv = process.argv.slice(2).filter((arg) => arg !== "--no-presets-onboard");
// Names the outermost command in write-log.mjs entries; child processes (the installer behind
// `roborepo update`) inherit it instead of logging their own internal invocation.
process.env.ROBOREPO_WRITE_ACTOR = sanitizeWriteActor(process.env.ROBOREPO_WRITE_ACTOR || `roborepo ${argv.join(" ")}`.trim());
const catalog = loadCommandCatalog();
validateExecutions({ catalog });

async function dispatch(args) {
  const resolved = resolveCommand(catalog, args);
  if (resolved.kind === "root-menu") {
    // Only a bare interactive invocation on an uninitialized install reroutes; every explicit
    // command stays reachable. See first-run-routing.mjs for the full policy.
    if (shouldRouteToInit({ args })) {
      const { initCommand } = await import("./initialize.mjs");
      return initCommand([]);
    }
    return runInteractiveMenu({ catalog, dispatchCommand });
  }
  if (resolved.kind === "menu") {
    return runInteractiveMenu({
      catalog,
      node: resolved.node,
      tokens: resolved.tokens,
      dispatchCommand,
    });
  }
  if (resolved.kind === "help") {
    console.log(renderHelp(catalog, resolved.node, resolved.tokens));
    return;
  }
  if (resolved.kind === "command") {
    return dispatchCommand(resolved.node, resolved.tokens, resolved.args);
  }
  if (resolved.kind === "removed") {
    return removedCommandError(resolved);
  }
  return invalidCommandError(resolved);
}

async function dispatchCommand(node, tokens, args) {
  return executeCommand({ catalog, node, tokens, args });
}

function removedCommandError({ replacement }) {
  console.error(replacement.message || "command removed");
  if (replacement.replacement?.length) {
    console.error(`Try: ${catalog.commandName} ${replacement.replacement.join(" ")}`);
  }
  process.exit(2);
}

function invalidCommandError({ tokens, suggestions }) {
  console.error(`unknown command: ${tokens.join(" ")}`);
  if (suggestions.length) console.error(`Did you mean: ${suggestions.join(", ")}?`);
  console.error(catalog.helpLabels.scopedHelpHint);
  process.exit(2);
}

dispatch(argv).catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
