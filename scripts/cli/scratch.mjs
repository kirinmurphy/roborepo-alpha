// `roborepo scratch <name>` — hand an agent a temporary folder that cleans itself up.
//
// Prints `<stateRoot>/scratch/<name>/`, creating it if needed, and prunes the scratch store by its
// registry policy. Running this command is the store's write path, so the store is pruned whenever
// agents use it, the way browser evidence is pruned when a browser run starts; no hook or schedule
// is involved. A call never removes the folder it is about to hand back.
//
// stdout carries only the path, so `dir=$(roborepo scratch <name>)` works; pruning reports go to
// stderr.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state-paths.mjs";
import { isBodyLocation } from "./delivery.mjs";
import {
  SCRATCH_STORE_ID,
  findRetentionStore,
  measureFolderSet,
  removeFolderSetEntries,
} from "../../modules/retention/index.mjs";

// One path segment, starting with a letter or digit: a plan id or a short topic. Leading dots,
// separators, and `..` are refused rather than normalized, so a name can never reach outside the
// store or hide a folder from a listing.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// The module adapter takes the exit status from process.exitCode, not the return value.
export function scratchCommand(args = []) {
  process.exitCode = runScratch(args);
}

function runScratch(args) {
  if (args.length !== 1 || !NAME_PATTERN.test(args[0])) {
    console.error("usage: roborepo scratch <name>");
    console.error("<name> is one path segment: letters, digits, '.', '_', '-', starting with a letter or digit");
    return 2;
  }
  const store = findRetentionStore(stateDir, SCRATCH_STORE_ID);
  try {
    const folder = openScratchFolder(store.target, args[0]);
    pruneScratch(store, folder);
    const note = bodyLocationNote(folder);
    if (note) console.error(note);
    console.log(folder);
    return 0;
  } catch (error) {
    console.error(`scratch: ${error.message}`);
    return 1;
  }
}

// The note printed when `folder` is outside what `roborepo delivery pr-body` reads, or null. `roots`
// defaults to pr-body's own; a test passes explicit roots so the outside case is covered wherever
// the checkout and TMPDIR live.
export function bodyLocationNote(folder, roots) {
  if (isBodyLocation(folder, roots)) return null;
  return `scratch: note: this folder is outside what \`roborepo delivery pr-body\` reads (an overridden`
    + " ROBOREPO_STATE_ROOT or HOME moved it); write a PR body file in the system temp folder instead";
}

export function openScratchFolder(root, name, { now = new Date() } = {}) {
  fs.mkdirSync(root, { recursive: true });
  // A sandboxed shell can write the scratch folder, so it could replace the store with a link;
  // handing out and pruning folders through that link would reach wherever it points.
  if (!fs.lstatSync(root).isDirectory()) throw new Error(`${root} is not a folder; refusing to use it`);
  const folder = path.join(root, name);
  try {
    fs.mkdirSync(folder);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  // A link or file under the name is not a scratch folder this command made; refuse it rather than
  // handing out a path that leads somewhere else.
  if (!fs.lstatSync(folder).isDirectory()) throw new Error(`${folder} exists and is not a folder`);
  fs.utimesSync(folder, now, now);
  return folder;
}

// The folder being handed out is never removed. Touching it keeps it out of the age rule and inside
// the byte cap's one-hour spare, but the clock jumping forward by over an hour between the touch and
// the measurement would move it into the byte walk, so it is also excluded by name.
function pruneScratch(store, keep) {
  const verdict = measureFolderSet({ dirPath: store.target, policy: store.policy });
  const paths = verdict.files.filter((entryPath) => entryPath !== keep);
  if (paths.length === 0) return;
  const { removed, refused } = removeFolderSetEntries({ dirPath: store.target, paths, measured: verdict.entries });
  if (removed.length) console.error(`scratch: removed ${removed.length} folder(s) unused for ${store.policy.maxAgeDays} days or over the cap`);
  for (const refusal of refused) console.error(`scratch: left ${refusal.path} (${refusal.reason})`);
}
