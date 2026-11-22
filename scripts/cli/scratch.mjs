// `roborepo scratch <name>` — hand an agent a temporary folder that cleans itself up.
//
// Prints `<stateRoot>/scratch/<name>/`, creating it if needed, and prunes the scratch store by its
// registry policy. Running this command is the store's write path, so the store is pruned whenever
// agents use it, the way browser evidence is pruned when a browser run starts; no hook or schedule
// is involved. The named folder is touched before pruning, so a call never removes the folder it is
// about to hand back.
//
// stdout carries only the path, so `dir=$(roborepo scratch <name>)` works; pruning reports go to
// stderr.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state-paths.mjs";
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
    pruneScratch(store);
    console.log(folder);
    return 0;
  } catch (error) {
    console.error(`scratch: ${error.message}`);
    return 1;
  }
}

export function openScratchFolder(root, name, { now = new Date() } = {}) {
  fs.mkdirSync(root, { recursive: true });
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

function pruneScratch(store) {
  const verdict = measureFolderSet({ dirPath: store.target, policy: store.policy });
  if (!verdict.act) return;
  const { removed, refused } = removeFolderSetEntries({ dirPath: store.target, paths: verdict.files });
  if (removed.length) console.error(`scratch: removed ${removed.length} folder(s) unused for ${store.policy.maxAgeDays} days or over the cap`);
  for (const refusal of refused) console.error(`scratch: left ${refusal.path} (${refusal.reason})`);
}
