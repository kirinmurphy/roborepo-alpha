// The agent account rows on Settings, one per forge provider with an agent account that the server
// lists (GitHub today: "Agent GitHub account"): whether agents act on that host as their bot
// account, and the one switch for it. Underneath each is the provider's package (for GitHub,
// `github-agent-identity`, which points agent shells at the bot's login), but the switch only turns
// on once the bot works, so turning it on never leaves agents without any login on the host. Setting
// the bot up happens from Home, which knows the repos the setup runs in; "Set it up" links there.
import { portalGetJson, portalPostJson } from "/portal/shared/api.js";

const SETUP_LINK = "/?agent-identity=setup";

export const agentAccountLabel = (provider) => `Agent ${provider.displayName} account`;

// `section` holds the heading and a row template; each provider gets its own copy of the row.
export async function mountAgentIdentitySettings(section, { onError }) {
  const list = section.querySelector('[data-slot="rows"]');
  const template = section.querySelector("template");
  let providers;
  try {
    providers = (await portalGetJson("/api/forge-providers")).filter((provider) => provider.capabilities.includes("agent-identity") && provider.packageId);
  } catch (error) {
    onError(error);
    return;
  }
  if (providers.length === 0) {
    section.hidden = true;
    return;
  }
  // One provider keeps its own name on the heading; several share a general one.
  const heading = section.querySelector('[data-slot="heading"]');
  heading.textContent = providers.length === 1 ? `Agent ${providers[0].displayName} Account` : "Agent Accounts";
  for (const provider of providers) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.provider = provider.id;
    list.append(row);
    mountAgentIdentityRow(row, provider, { onError });
  }
}

function mountAgentIdentityRow(row, provider, { onError }) {
  const slot = (name) => row.querySelector(`[data-slot="${name}"]`);
  const button = slot("action");
  const link = slot("link");
  const host = provider.displayName;
  const query = `provider=${encodeURIComponent(provider.id)}`;
  let report = null;

  row.setAttribute("aria-label", agentAccountLabel(provider));
  slot("description").textContent = `Agents push and open pull requests as a separate ${host} account, so ${host} itself stops them pushing to main or merging PRs no one approved.`;

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    onError(null);
    try {
      if (report.packageEnabled) {
        await portalPostJson("/api/config/packages", { id: provider.packageId, enabled: false });
      } else {
        const result = await portalPostJson(`/api/agent-identity/enable?${query}`, {});
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
      report = await portalGetJson(`/api/agent-identity?${query}${fresh ? "&fresh=1" : ""}`);
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
      status = bot ? `Off: ${bot} needs attention before agents can use it.` : `Off: agents act on ${host} as you.`;
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
