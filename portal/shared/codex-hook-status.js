// Codex telemetry hook warning, shared by Settings (which owns the token tracking toggle), Tokens,
// and Home.
// Codex owns hook trust, so token tracking can be on while Codex still refuses to run the capture
// hooks; this notice says so. Only checked when the warning could apply, since the status read
// starts a Codex app-server and can take seconds.

import { portalGetJson, portalTpl as tpl, portalFillSlots as fill } from "./api.js";

const MESSAGES = {
  review_required: ["Codex telemetry needs review", "Codex has the RoboRepo telemetry hooks, but will not run them until you review and trust them."],
  inactive: ["Codex telemetry is inactive", "The RoboRepo telemetry hooks are installed but disabled in Codex."],
  missing: ["Codex telemetry setup is incomplete", "Some RoboRepo telemetry hooks are missing from Codex. Turn token tracking off and back on in Settings to reinstall them."],
};

// `setup` is the /api/settings read model.
export function shouldCheckCodexHooks(setup) {
  return setup?.telemetry?.enabled === true
    && (setup.harnesses?.active || []).some((harness) => harness.id === "codex");
}

export function codexHookStatusNotice(status) {
  const message = MESSAGES[status?.state];
  return message ? fill(tpl("tpl-codex-hook-status"), { title: message[0], message: message[1] }) : null;
}

// Latest render per mount, so a slow status read cannot overwrite a newer one.
const renders = new WeakMap();

// Fills `mount` with the notice when Codex needs attention and hides it otherwise. A failed status
// read hides the notice: the warning is advisory, and the page has its own error surface.
export async function renderCodexHookStatus(mount, setup) {
  const token = {};
  renders.set(mount, token);
  let notice = null;
  if (shouldCheckCodexHooks(setup)) {
    try {
      notice = codexHookStatusNotice(await portalGetJson("/api/config/hooks/codex/status"));
    } catch {
      notice = null;
    }
  }
  if (renders.get(mount) !== token) return;
  mount.replaceChildren(...(notice ? [notice] : []));
  mount.hidden = !notice;
}
