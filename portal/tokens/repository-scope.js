// Tokens' side of the shared repository scope (portal/shared/repository-scope.js): which report URL
// to fetch, the unavailable state, and the note that the demo report ignores the scope. app.js
// calls these; the selector itself lives in the portal's repository sub-header row.
import {
  currentRepositoryScope,
  isRepositoryScopeUnavailable,
  onRepositoryScopeChange,
  withRepositoryScope,
} from "/portal/shared/repository-scope.js";
import { onRepositoryScopeResolved, repositoryScopeUnavailableNotice } from "/portal/shared/repository-scope-selector.js";

export { isRepositoryScopeUnavailable };

// `onChange` runs after the scope changes (selector, Clear, back/forward), so the page can drop its
// remembered report version — two empty scopes can share a version — and refetch.
export function createTokensRepositoryScope({ onChange }) {
  const unavailableHost = document.getElementById("tokens-scope-unavailable");
  const mockScopeNote = document.getElementById("mock-scope-note");
  onRepositoryScopeChange(onChange);
  // The demo report has no route to refuse a key, so for it the selector's own resolution decides.
  let selectorStatus = null;
  onRepositoryScopeResolved(({ scope, status }) => {
    const previous = selectorStatus;
    selectorStatus = scope === currentRepositoryScope() ? status : null;
    if ((previous === "unavailable") !== (selectorStatus === "unavailable")) onChange();
  });

  return {
    isScoped: () => Boolean(currentRepositoryScope()),
    // True when the demo report is about to show for a key the selector could not resolve.
    mockScopeUnavailable: (mock) => mock && selectorStatus === "unavailable",
    // The demo report (/api/tokens/mock) is one fixed spool, so it never carries the scope.
    reportPath: (mock) => (mock ? "/api/tokens/mock" : withRepositoryScope("/api/data")),
    // The unavailable state in place of the report; the caller hides the report itself. Polls
    // land here every few seconds, so an already-shown notice is kept (and keeps focus).
    showUnavailable() {
      if (!unavailableHost.hidden) return;
      unavailableHost.replaceChildren(repositoryScopeUnavailableNotice());
      unavailableHost.hidden = false;
    },
    isUnavailable: () => !unavailableHost.hidden,
    // Returns whether the unavailable state had been showing, so the caller can restore the report.
    clearUnavailable() {
      const wasShowing = !unavailableHost.hidden;
      unavailableHost.hidden = true;
      unavailableHost.replaceChildren();
      return wasShowing;
    },
    // Says so when the demo report is on screen while a repository is selected.
    markMockScope(showingMock) {
      mockScopeNote.hidden = !(showingMock && currentRepositoryScope());
    },
  };
}
