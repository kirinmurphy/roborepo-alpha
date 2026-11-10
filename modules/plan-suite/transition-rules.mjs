// What each lifecycle transition requires and writes, keyed by the transition ids declared in
// manifests/platform/plan-lifecycle.json. The manifest says which moves exist and which commands
// perform them; this module holds the rules, so the manifest never grows into a workflow engine.
//
// Each rule may define:
//   requires(options)          returns why the options are incomplete, or null, before anything is read
//   prepare(context)           async; refuses when the move is not allowed yet, and returns
//                              { content, evidence }: the plan text to commit and what was checked
//   bodyUnchanged              the post-commit check confirms the document body did not change
//   message(name, options)     the commit message; `name` is the plan's filename slug, which a
//                              reader recognizes in git log where the opaque id says nothing
import { domainError, writeFrontmatterField } from "./index.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { withInvalidatedApproval } from "./plan-writes.mjs";
import { approvalFreshness, completionPreflight } from "./review-gates.mjs";
import { planLanding } from "./landing-gate.mjs";

export const TRANSITION_RULES = {
  promote: {
    message: (name) => `Promote plan ${name} to ready`,
  },
  start: {
    requires: ({ worktree }) => (worktree ? null : "A worktree name is required (--worktree <name>)."),
    // An active plan may be pointed at another worktree, for example when the first one was lost.
    reassigns: true,
    prepare: ({ content, options }) => ({
      content: writeFrontmatterField(content, "worktree", options.worktree),
    }),
    bodyUnchanged: true,
    message: (name, { worktree }) => `Start plan ${name} in worktree ${worktree}`,
  },
  submit: {
    prepare: ({ primary, record, content, base }) => {
      const preflight = completionPreflight({ primary, record, base });
      if (!preflight.ok) refuse("Implementation is not complete, so the plan stays active.", preflight.checks, { preflight });
      return { content, evidence: { preflight } };
    },
    bodyUnchanged: true,
    message: (name) => `Submit plan ${name} for review`,
  },
  reopen: {
    // Reopening means the requirements changed, which an implementation comparison cannot see, and
    // `plans save` refuses approval edits, so the move itself retires any approval.
    prepare: ({ content }) => ({ content: withInvalidatedApproval(content) }),
    message: (name) => `Reopen plan ${name} for implementation`,
  },
  close: {
    prepare: async ({ primary, record, content, base }) => {
      const approval = approvalFreshness({ primary, record, base });
      if (approval.state === "unavailable") {
        refuseWith(`The human approval cannot be checked: ${approval.reason}.`,
          `Recreate the linked worktree named ${record.plan.worktree} on the plan's branch (for example \`git worktree add <path ending in ${record.plan.worktree}> <branch>\`), then close again.`, { approval });
      }
      if (approval.state !== "fresh") {
        refuseWith(`The human approval is ${approval.state}: ${approval.reason}.`,
          "Run /plan-review to review the current implementation and record approval, then close again.", { approval });
      }
      // A fresh approval for a plan that names a worktree means its branch resolved, so landing is
      // always checked against that branch; only a plan built on the base branch has none to check.
      // The absorbing commit recorded in the verification being closed is re-verified, not trusted.
      const landing = await planLanding({ primary, record, base, branch: approval.branch, markdown: content });
      if (!landing.landed) {
        refuseWith(`landed: unconfirmed (${landing.reason}).`,
          `Merge ${approval.branch} into ${base} through its pull request and update the local ${base}, then close again.`, { landing });
      }
      // Review requires a next action and Completed forbids one, so no save can clear it; the move does.
      return { content: writeFrontmatterField(content, "next_action", ""), evidence: { approval, landing } };
    },
    message: (name) => `Close plan ${name}`,
  },
  archive: {
    clearsReferences: true,
    requires: ({ reason }) => (reason?.trim() ? null : "An archive reason is required (--reason <text>)."),
    prepare: ({ content, options, today }) => {
      const base = writeFrontmatterField(content, "next_action", "");
      return { content: `${base.replace(/\s*$/, "")}\n\n## Archived\n\n${today}: ${options.reason.trim()}\n` };
    },
    message: (name) => `Archive plan ${name}`,
  },
};

// Every transition the manifest declares needs rules here; a missing entry is a programming error.
for (const transition of LIFECYCLE_MODEL.transitions) {
  if (!TRANSITION_RULES[transition.id]) throw new Error(`plan transition ${transition.id} has no rules in transition-rules.mjs`);
}

function refuse(message, checks, evidence) {
  const failed = checks.filter((check) => !check.ok);
  throw Object.assign(domainError("LIFECYCLE_REQUIREMENTS", message, {
    resolution: failed.map((check) => `${check.name}: ${check.fix}`).join("; "),
    details: failed.map((check) => `check ${check.n} (${check.name}): ${check.observed}`),
  }), { evidence });
}

function refuseWith(message, resolution, evidence = {}) {
  throw Object.assign(domainError("LIFECYCLE_REQUIREMENTS", message, { resolution }), { evidence });
}
