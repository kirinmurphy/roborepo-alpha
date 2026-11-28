// The error every forge provider's reads and writes throw, so code outside a provider can tell a
// host refusing or not answering from a bug without naming the provider. `kind: "http"` carries the
// status and message the host answered with; `kind: "unavailable"` means no answer was received (the
// CLI missing, not signed in, timed out, or the network failed) and `message` says which.
export class ForgeError extends Error {
  constructor(kind, message, { status = null } = {}) {
    super(message);
    this.name = "ForgeError";
    this.kind = kind;
    this.status = status;
  }
}
