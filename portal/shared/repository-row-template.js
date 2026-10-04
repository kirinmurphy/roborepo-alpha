const checkoutTemplate = document.createElement("template");
checkoutTemplate.innerHTML = `
  <div class="repository-root">
    <div class="repository-root-head">
      <portal-icon class="repository-root-glyph" data-slot="root-glyph" name="home"></portal-icon>
      <div class="repository-root-identity">
        <div class="repository-root-identity-line">
          <span class="info-wrap repository-root-trigger" data-slot="root-info" data-tip-html="template" data-tip-placement="panel" hidden>
            <span class="repository-root-branch" data-slot="root-branch"></span>
            <template>
              <span class="info-tooltip-content">
                <span class="info-tooltip-heading"><portal-icon name="git-branch"></portal-icon><span data-slot="root-heading"></span></span>
                <span class="info-tooltip-subheading" data-slot="root-subheading-line" hidden><portal-icon data-slot="root-subheading-icon" name="home"></portal-icon><span data-slot="root-subheading"></span></span>
                <span data-slot="root-state-detail" hidden><strong>State</strong><span data-slot="root-state-text"></span></span>
                <span class="info-tooltip-group" data-slot="root-checkout-group">Checkout</span>
                <span data-slot="root-path-detail" hidden><strong>Path</strong><span data-slot="root-path-text"></span></span>
                <span><strong>Members</strong><span data-slot="root-members-detail"></span></span>
                <span class="info-tooltip-group">Git</span>
                <span data-slot="git-detail" hidden><strong>Tracking</strong><span data-slot="git-detail-text"></span></span>
                <span data-slot="git-commit-detail" hidden><strong>Commit</strong><span data-slot="git-commit-text"></span></span>
                <span data-slot="git-status-detail" hidden><strong>Working tree</strong><span data-slot="git-status-text"></span></span>
                <span data-slot="git-drift-detail" hidden><strong>Drift</strong><span data-slot="git-drift-text"></span></span>
                <span data-slot="git-fetch-detail" hidden><strong>Fetched</strong><span data-slot="git-fetch-text"></span></span>
              </span>
            </template>
          </span>
          <span class="repository-root-copy" data-slot="root-copy"></span>
          <span class="git-drift" data-slot="git-drift" hidden></span>
        </div>
      </div>
      <div class="repository-root-actions checkout-actions">
        <span class="port-health-badge" data-slot="root-health" hidden></span>
        <span class="resource-concern-badge" data-slot="resource-concern" hidden></span>
        <a class="repository-entrypoint" data-slot="root-entrypoint" target="_blank" rel="noreferrer" hidden></a>
        <span class="checkout-links-cell"><span data-slot="root-links" hidden></span></span>
        <span class="repository-root-control checkout-control-cell">
          <span class="repository-root-menu" data-slot="root-menu" hidden></span>
          <button type="button" class="repository-root-toggle" data-action="toggle-members" aria-expanded="false" hidden>
            <portal-icon name="chevron" class="compose-project-chevron"></portal-icon>
          </button>
        </span>
      </div>
    </div>
    <div class="repository-members" data-slot="members" hidden></div>
  </div>`;

export function createRepositoryCheckoutRow({ controls = true } = {}) {
  const row = checkoutTemplate.content.firstElementChild.cloneNode(true);
  if (!controls) {
    row.querySelector(".checkout-control-cell")?.remove();
  }
  return row;
}
