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
    review_required: "Review the listed RoboRepo hooks in Codex and trust only those. Newly trusted hooks run from the next Codex session.",
    reviewApp: desktopFirst ? "In the ChatGPT desktop app, use the hook review notice or Settings → Hooks." : null,
    inactive: desktopFirst
      ? "In the ChatGPT desktop app, open Settings → Hooks and turn the listed RoboRepo hooks back on."
      : "Open /hooks in the Codex CLI and turn the listed RoboRepo hooks back on.",
    terminalHint: desktopFirst
      ? "Alternatively, run this command in a terminal. Codex shows Hooks need review when it starts:"
      : "Run this command in a terminal. Codex shows Hooks need review when it starts:",
    packageReview: {
      message: "These hooks were installed by enabled RoboRepo packages, separately from the core Hooks bundle.",
      mixedMessage: "These pending hooks include RoboRepo’s core hooks and hooks installed by enabled packages.",
      purposeLabel: "Why?",
      cliSetupLabel: "Set up via CLI",
      cliSetup: ["Package hooks installed.", cliStep, "Approve only the pending RoboRepo hooks listed below.", "Start a new Codex session."],
      steps: ["Package hooks installed.", desktopFirst ? desktopStep : cliStep, "Approve only the pending RoboRepo hooks listed below.", "Start a new Codex session."],
    },
    missingCore: {
      title: "Install RoboRepo’s core hooks for Codex/ChatGPT",
      message: "",
      purposeLabel: "Why?",
      cliSetupLabel: "Set up via CLI",
      cliSetup: [
        "Install hooks with the same button above.",
        "Open the Codex CLI.",
        "Approve only the pending RoboRepo hooks listed here.",
        "Start a new Codex session.",
      ],
      steps: ["Install hooks with the button below.", desktopFirst ? desktopStep : cliStep, "Approve only the pending RoboRepo hooks listed here.", "Start a new Codex session."],
      installLabel: "Install hooks",
      manualApprovalStep: desktopFirst ? desktopStep : cliStep,
    },
  };
}
