// What a person does on github.com to give agents their bot account: the pages to open, the
// classic token's scopes and note, and the expiry advice. `roborepo github setup` prints these
// while it waits, and the portal's bot identity card links the same pages, so both say the same thing.
import { EXPIRING_DAYS } from "./agent-identity.mjs";

export const SETUP_COMMAND = "roborepo github setup";
export const TOKEN_SCOPES = ["repo", "read:org"];
export const TOKEN_NOTE = "RoboRepo agents";

export const GITHUB_PAGES = {
  signup: "https://github.com/signup",
  tokens: "https://github.com/settings/tokens",
  newToken: "https://github.com/settings/tokens/new",
};

export const scopesText = () => `${TOKEN_SCOPES.join(" and ")} only (not workflow)`;

export const expiryAdvice = () =>
  `90 days is a good default. roborepo doctor and roborepo github status warn ${EXPIRING_DAYS} days before it ends; renew by rerunning ${SETUP_COMMAND}.`;

// The portal's copy of the guide. Plain data, so the browser renders it without importing
// server code. Each step is done signed in as the bot, which is often another browser or a private
// window, so the portal shows each page's address to copy there rather than a link that would open
// in your own session. `id` lets the portal mark a step the status already shows as done.
export function setupGuide() {
  return {
    command: SETUP_COMMAND,
    lead: "Do these as the bot account, not as you. Copy each address into the browser or private window where the bot is signed in; opening it here would use your own account.",
    steps: [
      { id: "account", label: "Create the bot account", url: GITHUB_PAGES.signup, note: "In a private window or another browser, so your own session stays signed in." },
      { id: "token", label: "Create a classic token", url: GITHUB_PAGES.newToken, note: `Note "${TOKEN_NOTE}"; scopes ${scopesText()}.` },
      { id: "renew", label: "Renew the token", url: GITHUB_PAGES.tokens, note: `Open "${TOKEN_NOTE}" and choose Regenerate token; the scopes stay the same.` },
    ],
    expiry: expiryAdvice(),
    tokenWarning: "Paste the token only at the setup's hidden prompt in your terminal, never into the portal or an agent chat.",
  };
}
