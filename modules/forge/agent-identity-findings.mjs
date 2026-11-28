// Shared pieces of an agent identity report that every forge provider's adapter and the generic
// reader (agent-identity.mjs) build with: the finding shape, the commands a finding's fix names, and
// the token expiry check. A leaf module with no imports, so a provider can use it without loading
// the reader or the registry.

// How early status and doctor start warning that the bot's token is about to expire. Two weeks
// leaves room to notice the note between doctor runs.
export const EXPIRING_DAYS = 14;

// `severity` is `problem`, `warn` (advice), `unchecked` (a read that could not run), or `unverified`.
export function finding(id, message, fix, severity = "problem") {
  return { id, message, fix, severity };
}

// The commands a person runs for one provider's agent account. Every provider's commands sit under
// the shared `git` namespace, named by its manifest's `agent.commandNamespace`.
export const setupCommand = (provider) => `roborepo git ${provider.manifest.agent.commandNamespace} setup`;
export const statusCommand = (provider) => `roborepo git ${provider.manifest.agent.commandNamespace} status`;
export const enableCommand = (provider) => `roborepo package enable ${provider.manifest.agent.packageId}`;
export const setupFix = (provider) => `Run ${setupCommand(provider)} in your own terminal.`;

// A token without an expiry date is only advice: it works, but nothing bounds how long a leaked
// copy keeps working.
export function expiryProblems(expiresAt, provider) {
  const fix = setupFix(provider);
  if (!expiresAt) {
    return [finding("no-expiry", "The bot's token never expires, so a leaked copy would keep working.", `Regenerate it with an expiry date (90 days is a good default), then run ${setupCommand(provider)} in your own terminal.`, "warn")];
  }
  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft <= 0) return [finding("expired", "The bot's token has expired.", fix)];
  if (msLeft < EXPIRING_DAYS * 86_400_000) {
    const days = Math.max(1, Math.ceil(msLeft / 86_400_000));
    return [finding("expiring", `The bot's token expires in ${days} day${days === 1 ? "" : "s"}.`, fix, "warn")];
  }
  return [];
}

// A finding only the repo's owner can fix, when you do not administer the repo, carries
// `owner: true`, and its fix asks you to send them the message.
export const askOwner = (what) => `Ask the repo's owner to ${what}; send them the message below.`;

// "A, B, or C" for the variables a message lists.
export function listOr(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

// Setup stops with a message for the person, never a stack trace.
export class SetupStop extends Error {}
export const stopSetup = (message) => { throw new SetupStop(message); };
// A token that signed in but whose scopes or expiry setup does not accept. `findings` says why.
export class TokenRejected extends SetupStop {}
