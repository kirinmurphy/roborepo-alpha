import { portalGetJson } from "/portal/shared/api.js";

export function fetchSetupState() {
  return portalGetJson("/api/settings");
}
