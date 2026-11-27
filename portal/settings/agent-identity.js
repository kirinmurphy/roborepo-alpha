// The Agent GitHub account row on Settings: whether agents act on GitHub as their bot account, and
// the one switch for it. Underneath it is the `github-agent-identity` package (it points agent
// shells at the bot's login), but the switch only turns on once the bot works, so turning it on
// never leaves agents without any GitHub login. Setting the bot up happens from Home, which knows
// the repos the setup runs in; "Set it up" links there.
import { portalGetJson, portalPostJson } from "/portal/shared/api.js";

const PACKAGE_ID = "github-agent-identity";
const SETUP_LINK = "/?agent-identity=setup";

export function mountAgentIdentitySetting(row, { onError }) {
  const slot = (name) => row.querySelector(`[data-slot="${name}"]`);
  const button = slot("action");
  const link = slot("link");
  let report = null;

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    onError(null);
    try {
      if (report.packageEnabled) {
        await portalPostJson("/api/config/packages", { id: PACKAGE_ID, enabled: false });
      } else {
        const result = await portalPostJson("/api/agent-identity/enable", {});
        if (!result.enabled) onError(new Error(result.message));
      }
      await load(true);
    } catch (error) {
      onError(error);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });

  async function load(fresh = false) {
    try {
      report = await portalGetJson(`/api/agent-identity${fresh ? "?fresh=1" : ""}`);
      render();
    } catch (error) {
      slot("status").textContent = `Status unavailable: ${error.message}`;
      button.hidden = true;
      link.hidden = true;
    }
  }

  function render() {
    const bot = report.botLogin || report.savedLogin;
    const working = report.state === "healthy";
    let status;
    let action = null;
    let linkText = null;
    if (report.packageEnabled) {
      // The "Agents use their bot account" line above says it is on; this names the bot and token.
      status = working ? `${bot} · token ${report.expiresAt ? `expires ${new Date(report.expiresAt).toLocaleDateString()}` : "has no expiry date"}` : "On, but the bot account needs attention.";
      action = "Turn off";
      linkText = working ? "Details" : "Fix it";
    } else if (report.enableOffered) {
      status = `${bot} is ready; agents act as you.`;
      action = "Turn on";
    } else {
      status = bot ? `Off: ${bot} needs attention before agents can use it.` : "Off: agents act on GitHub as you.";
      linkText = "Set it up";
    }
    slot("status").textContent = status;
    slot("active").hidden = !(report.packageEnabled && working);
    button.hidden = !action;
    button.textContent = action || "";
    link.hidden = !linkText;
    link.textContent = linkText || "";
    link.href = SETUP_LINK;
  }

  void load();
}
