// Session titles that name the plan-workflow stage, so a person running many agent sessions can
// tell them apart. Pure: formats and parses text, touches no files and no harness.
//
// The rule text in globals/packages/plan-suite/rules.md states this format for the agent; a test
// keeps the prefixes written there equal to STAGE_PREFIXES.
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";

// The Claude desktop app requires a title passed at launch to be under 60 characters.
export const SESSION_TITLE_MAX = 59;

export const SUB_TASK_KIND = "sub-task";
export const QUICK_CHANGE_KIND = "quick-change";

// A plan command's kind is the command itself (`plan-execute`), so a command added to the lifecycle
// gets a prefix without a second list.
const KIND_PREFIXES = new Map([
  ...LIFECYCLE_MODEL.commands.map((command) => [command, `/${command}:`]),
  [SUB_TASK_KIND, "/plan sub-task:"],
  [QUICK_CHANGE_KIND, "Quick Change:"],
]);

export const STAGE_PREFIXES = Object.freeze([...KIND_PREFIXES.values()]);

// The line a copied portal prompt carries so the agent, the person, and the title hook all see the
// same title.
export const TITLE_LINE_LABEL = "Session title:";

const ELLIPSIS = "…";

// `kind` is a plan command (`plan-review`), SUB_TASK_KIND, or QUICK_CHANGE_KIND. Returns null for an
// unknown kind or an empty description.
export function sessionTitle(kind, description) {
  const prefix = KIND_PREFIXES.get(kind);
  const text = collapse(description);
  if (!prefix || !text) return null;
  return fitTitle(`${prefix} ${text}`);
}

export function hasStagePrefix(title) {
  if (typeof title !== "string") return false;
  return STAGE_PREFIXES.some((prefix) => title.startsWith(`${prefix} `));
}

export function titleLine(title) {
  return `${TITLE_LINE_LABEL} ${title}`;
}

// The title from a prompt's title line, or null when it has none or the line does not carry a stage
// prefix: the hook only ever sets titles in this format.
export function titleFromPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${TITLE_LINE_LABEL} `)) continue;
    const title = collapse(trimmed.slice(TITLE_LINE_LABEL.length));
    return hasStagePrefix(title) ? fitTitle(title) : null;
  }
  return null;
}

// `{ command, rest }` when the prompt's first non-blank line opens with a plan command, where `rest`
// is the prompt text after the command; otherwise null.
export function leadingPlanCommand(prompt) {
  if (typeof prompt !== "string") return null;
  const match = /^\s*\/([a-z][a-z0-9-]*)(?=\s|$)/.exec(prompt);
  if (!match || !LIFECYCLE_MODEL.commands.includes(match[1])) return null;
  return { command: match[1], rest: prompt.slice(match[0].length) };
}

// The distinct plan records `text` names, from a plan snapshot's records. A word names a plan by its
// id, its store-relative path, or its file name: a plan keeps its file name when it moves between
// lifecycle folders, so a path typed before a move still finds it.
export function namedPlans(text, records) {
  if (typeof text !== "string") return [];
  const words = new Set(text.split(/\s+/).map((word) => word.replace(/^[`'"(<[]+|[`'")>\],.;:!?]+$/g, "")).filter(Boolean));
  const found = new Set();
  for (const record of records) {
    const { id, relativePath } = record.plan;
    const fileName = relativePath.split("/").pop();
    for (const word of words) {
      if ((id && word === id) || word === relativePath || word.split(/[\\/]/).pop() === fileName) {
        found.add(record);
        break;
      }
    }
  }
  return [...found];
}

// Cuts a title over SESSION_TITLE_MAX at a word boundary and ends it with an ellipsis. The prefix is
// never cut; a single word longer than the room left is cut mid-word.
function fitTitle(title) {
  if (title.length <= SESSION_TITLE_MAX) return title;
  const room = SESSION_TITLE_MAX - ELLIPSIS.length;
  const head = title.slice(0, room + 1);
  const boundary = head.lastIndexOf(" ");
  const prefixEnd = title.indexOf(" ") + 1;
  const cut = boundary > prefixEnd ? head.slice(0, boundary) : head.slice(0, room);
  return `${cut.replace(/[\s.,;:!?-]+$/, "")}${ELLIPSIS}`;
}

function collapse(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}
