// Availability is discovery evidence, not proof of which interface a person is currently using.
// A detected desktop runtime includes a usable CLI, so desktop review can retain that fallback.
import { shellQuote } from "../shell-quote.mjs";

export function codexHookGuidance(evidence = []) {
  const desktop = evidence.find((item) => item.kind === "executable" && item.source === "desktop");
  const cli = evidence.find((item) => item.kind === "executable" && item.source === "cli");
  const executable = (desktop || cli)?.resolvedPath;
  const desktopFirst = Boolean(desktop);
  const desktopStep = "In the ChatGPT desktop app, select the anchor icon below the chat prompt (or go to Settings → Hooks).";
  const cliStep = "Open the Codex CLI.";
  return {
    preferredInterface: desktopFirst ? "desktop" : "cli",
    command: executable ? shellQuote(executable) : null,
    review: executable ? { executable, args: [] } : null,
    reviewButtonLabel: desktopFirst ? "Open Codex CLI instead" : "Open Codex hook review",
    terminalOptionLabel: desktopFirst ? "Use the Codex CLI instead" : "Terminal command",
    review_required: "Review the listed RoboRepo hooks in Codex and trust only those. If Codex also lists hooks you do not recognize, leave them alone rather than choosing Trust all. Newly trusted hooks run from the next Codex session.",
    reviewApp: desktopFirst ? "In the ChatGPT desktop app, use the hook review notice or Settings → Hooks." : null,
    inactive: desktopFirst
      ? "In the ChatGPT desktop app, open Settings → Hooks and turn the listed RoboRepo hooks back on."
      : "Open /hooks in the Codex CLI and turn the listed RoboRepo hooks back on.",
    terminalHint: desktopFirst
      ? "Alternatively, run this command in a terminal. Codex shows Hooks need review when it starts:"
      : "Run this command in a terminal. Codex shows Hooks need review when it starts:",
    missingCore: {
      title: "Install RoboRepo’s core hooks for Codex/ChatGPT",
      message: "",
      purposeLabel: "Why?",
      reviewCaution: "If Codex also lists hooks you do not recognize, leave them alone rather than choosing Trust all.",
      purpose: [
        { name: "SessionStart", description: "RoboRepo: unmanaged skills check — Checks ~/.codex/skills for skill folders outside RoboRepo’s managed links and suggests adopting them into RoboRepo." },
        { name: "PreToolUse", description: "RoboRepo: command permissions applies command rules. RoboRepo: concise command output limits build/lint/typecheck output to 120 lines and blocks matching watch, verbose, and debug commands." },
      ],
      cliSetupLabel: "Set up via CLI",
      cliSetup: [
        "Install hooks with the same button above.",
        "Open the Codex CLI.",
        "Approve RoboRepo’s three core hooks under SessionStart and PreToolUse.",
        "Start a new Codex session.",
      ],
      steps: ["Install hooks with the button below.", desktopFirst ? desktopStep : cliStep, "Approve RoboRepo’s three core hooks under SessionStart and PreToolUse.", "Start a new Codex session."],
      installLabel: "Install hooks",
      manualApprovalStep: desktopFirst ? desktopStep : cliStep,
    },
  };
}
