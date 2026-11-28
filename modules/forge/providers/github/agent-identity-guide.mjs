// What a person does on github.com to give agents their bot account: the pages to open, the
// classic token's scopes and note, and the expiry advice. `roborepo git github setup` prints these
// while it waits, and the portal's bot identity card links the same pages, so both say the same thing.
import { EXPIRING_DAYS, setupCommand, statusCommand } from "../../agent-identity-findings.mjs";
import { githubSelf } from "./manifest.mjs";

export const SETUP_COMMAND = setupCommand(githubSelf);
export const TOKEN_SCOPES = ["repo", "read:org"];
export const TOKEN_NOTE = "RoboRepo agents";

export const GITHUB_PAGES = {
  signup: "https://github.com/signup",
  tokens: "https://github.com/settings/tokens",
  newToken: "https://github.com/settings/tokens/new",
};

export const scopesText = () => `${TOKEN_SCOPES.join(" and ")} only (not workflow)`;

export const expiryAdvice = () =>
  `90 days is a good default. roborepo doctor and ${statusCommand(githubSelf)} warn ${EXPIRING_DAYS} days before it ends; renew by rerunning ${SETUP_COMMAND}.`;

// The portal's copy of the guide. Plain data, so the browser renders it without importing
// server code. Each step is done signed in as the bot, which is often another browser or a private
// window, so the portal shows each page's address to copy there rather than a link that would open
// in your own session. `id` lets the portal put each step under the item it completes.
export function setupGuide() {
  return {
    command: SETUP_COMMAND,
    lead: "Open copied links where the bot is signed in, not in your own browser.",
    steps: [
      { id: "account", label: "Create the bot account", url: GITHUB_PAGES.signup, note: "Sign up in a private window or another browser." },
      { id: "token", label: "Create a classic token", url: GITHUB_PAGES.newToken, note: `As the bot: name it "${TOKEN_NOTE}", scopes ${TOKEN_SCOPES.join(" and ")} only.` },
      { id: "renew", label: "Renew the token", url: GITHUB_PAGES.tokens, note: `As the bot: regenerate "${TOKEN_NOTE}"; the scopes stay the same.` },
    ],
  };
}
