// The portal's view of branch protection for one listed repo: the same read and apply flow as
// `roborepo protect`, limited to repos in the registry and to a timeout a page load can wait for.
import { applyProtection, readProtection } from "../../modules/forge/protection.mjs";
import { loadRepositoryPayload } from "./repositories.mjs";

// Per GitHub call. A read that takes longer reports `unavailable` instead of holding the page.
const PORTAL_TIMEOUT_MS = 8000;

// Async so an unknown repo rejects instead of throwing synchronously. A GitHub failure does not
// reject: it resolves to an `unavailable` or `unsupported` report.
export async function loadRepositoryProtection({ repositoryId, stateRoot }) {
  return readProtection(protectionTarget({ repositoryId, stateRoot }));
}

// `action` is `protect`, `skip`, or `unskip`. Answers with the state after the action, the managed
// rulesets it wrote, and `refusal` saying why it stopped early or wrote none.
export async function applyRepositoryProtection({ repositoryId, action, stateRoot }) {
  const { report, changes, refusal } = await applyProtection(protectionTarget({ repositoryId, stateRoot }), { action });
  return { ...report, changes: changes.map(({ action: kind, name, enforcement }) => ({ action: kind, name, enforcement })), refusal };
}

// Throws NOT_FOUND for an id the portal does not list, so the routes act only on known repos.
function protectionTarget({ repositoryId, stateRoot }) {
  loadRepositoryPayload({ repositoryId, stateRoot });
  return { repositoryId, timeoutMs: PORTAL_TIMEOUT_MS };
}
