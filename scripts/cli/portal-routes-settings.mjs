// Shared setup-state read route. It is intentionally read-only and tokenless; mutations stay on
// their owning repository, harness, and package routes.
import { send } from "./portal-routes-http.mjs";
import { defineRoutes } from "./portal-router.mjs";

export const settingsRoutes = defineRoutes([
  {
    method: "GET",
    path: "/api/settings",
    handler: (req, res, { handlers }) => {
      send(res, 200, "application/json", JSON.stringify(handlers.loadSetupState()));
      return true;
    },
  },
]);
