export const DEFAULT_WORKTREE_STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveWorktreeStaleDays({ preference = DEFAULT_WORKTREE_STALE_DAYS, environment = undefined } = {}) {
  const source = environment == null || environment === "" ? "setting" : "environment";
  const value = source === "environment" ? Number(environment) : preference;
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    return { days: DEFAULT_WORKTREE_STALE_DAYS, finding: `invalid ${source} worktree stale days: ${source === "environment" ? environment : preference}` };
  }
  return { days: value, finding: null };
}

// The state is a view of current observations: landed outranks running, which outranks stale.
export function deriveWorktreeState({ running = false, landed = false, activityAt = [], staleDays = DEFAULT_WORKTREE_STALE_DAYS, now = new Date() } = {}) {
  const times = activityAt.map((value) => Date.parse(value)).filter(Number.isFinite);
  const lastActivity = times.length ? Math.max(...times) : null;
  let state = "idle";
  if (running) state = "running";
  else if (lastActivity != null && now.getTime() - lastActivity >= staleDays * DAY_MS) state = "stale";
  if (landed) state = "landed";
  return { state, lastActivityAt: lastActivity == null ? null : new Date(lastActivity).toISOString() };
}
