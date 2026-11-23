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

// The portal card's copy of the guide. Plain data, so the browser renders it without importing
// server code.
export function setupGuide() {
  return {
    command: SETUP_COMMAND,
    links: [
      { label: "Create the bot account", url: GITHUB_PAGES.signup, note: "In a private window, so your own session stays signed in." },
      { label: "New classic token", url: GITHUB_PAGES.newToken, note: `Signed in as the bot. Note "${TOKEN_NOTE}"; scopes ${scopesText()}.` },
      { label: "Bot's tokens (renew)", url: GITHUB_PAGES.tokens, note: `Signed in as the bot: open "${TOKEN_NOTE}" and choose Regenerate token.` },
    ],
    expiry: expiryAdvice(),
    tokenWarning: "Paste the token only at the setup's hidden prompt in your terminal, never into the portal or an agent chat.",
  };
}
