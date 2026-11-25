// `roborepo plans session-title --harness <id>`: the plan-suite title hook. The harness runs it on
// every submitted prompt with the hook input on standard input; when the prompt starts a plan stage
// it prints the output that titles the session after that stage and plan.
//
// It runs on every prompt, so it is silent and cheap: it reads the plan store only when the prompt
// opens with a plan command and has no title line, and then only each plan's id and heading. It
// never fails a prompt: every refusal and every error exits 0 with no output.
import fs from "node:fs";
import { listPlanTitles } from "../../modules/plan-suite/index.mjs";
import { hasStagePrefix, leadingPlanCommand, namedPlans, sessionTitle, titleFromPrompt } from "../../modules/plan-suite/session-title.mjs";
import { getHarnessProvider, hasHarnessProvider } from "../harnesses/registry.mjs";

export function plansSessionTitleCommand(args, { input = readStdin(), cwd = process.cwd(), write = (text) => process.stdout.write(text) } = {}) {
  try {
    const output = sessionTitleHookOutput({ harness: harnessArg(args), input, cwd });
    if (output) write(`${output}\n`);
  } catch {
    // A title is a convenience; nothing here may block the prompt it rides on.
  }
}

// The text the hook prints, or null when this prompt sets no title.
export function sessionTitleHookOutput({ harness, input, cwd }) {
  if (!harness || !hasHarnessProvider(harness)) return null;
  const provider = getHarnessProvider(harness);
  if (!provider.manifest.capabilities.includes("session-title")) return null;
  const { prompt, title: current } = provider.adapters.sessionTitle.readHookInput(input);
  const lineTitle = titleFromPrompt(prompt);
  const lead = leadingPlanCommand(prompt);
  if (!lineTitle && !lead) return null;
  // A hand-written name is never replaced; a stage title is, which is how the title follows the
  // session to its next stage.
  if (current && !hasStagePrefix(current)) return null;
  const title = lineTitle || titleForCommand(lead, cwd);
  if (!title || title === current) return null;
  return provider.adapters.sessionTitle.hookOutput({ title });
}

function titleForCommand({ command, rest }, cwd) {
  let records = [];
  try {
    records = listPlanTitles({ cwd });
  } catch {
    // No plan store here: the prompt can still be titled from its own words.
  }
  const named = namedPlans(rest, records);
  if (named.length > 1) return null;
  if (named.length === 1) return sessionTitle(command, named[0].plan.title);
  // Only /plan-write can target a plan that does not exist yet, so only it falls back to the
  // prompt's words. Any other command naming nothing found was given an unknown id or path, which
  // must not become the title.
  return command === PLAN_WRITE ? sessionTitle(command, rest) : null;
}

const PLAN_WRITE = "plan-write";

function harnessArg(args) {
  const index = args.indexOf("--harness");
  if (index !== -1) return args[index + 1] || null;
  const inline = args.find((arg) => arg.startsWith("--harness="));
  return inline ? inline.slice("--harness=".length) : null;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
