import { portalGetJson } from "./api.js";

export function fetchSetupState() {
  return portalGetJson("/api/settings");
}
