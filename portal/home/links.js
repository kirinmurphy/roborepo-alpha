import { configureLinksTrigger } from "/portal/shared/repository-components.js";
import { buildRoutesDropdown, fillApiRouteDialog } from "/portal/developer-runtime/suggestions-view.js";

// Home uses Runtime's route discovery and panel, scoped to the promoted application.
export function mountHomeLinks(slot, entrypoint, { onStale } = {}) {
  const button = document.createElement("portal-menu-button");
  configureLinksTrigger(button);
  const toggle = button.toggle.bind(button);
  let pending = false;
  button.toggle = async () => {
    if (pending) return;
    if (!button.panelContent) {
      pending = true;
      try {
        button.panelContent = await buildRoutesDropdown({}, entrypoint, {
          userLinks: entrypoint.links || [],
          onStale,
          onOpenApiRoute: (instance, suggestion) => {
            button.close();
            const dialog = document.getElementById("api-route-dialog");
            fillApiRouteDialog(dialog, instance, suggestion);
            dialog.showModal();
          },
        });
      } finally {
        pending = false;
      }
    }
    if (button.isConnected) toggle();
  };
  slot.replaceWith(button);
}
