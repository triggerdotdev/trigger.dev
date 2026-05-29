/**
 * Runs once on the client, synchronously, before React hydrates the app.
 * Reserved for housekeeping that must happen before any component mounts.
 */
export function clientBeforeFirstRender() {
  cleanupLegacyResizablePanelStorage();
}

/**
 * Earlier versions of the resizable panel library wrote a per-session
 * localStorage entry for every PanelGroup, including ones without an
 * `autosaveId`. The keys look like `panel-group-react-aria<n>-:<rid>:`
 * and accumulate without bound across sessions until they exhaust the
 * ~5 MB origin quota and break subsequent `setItem` calls.
 *
 * The library no longer behaves this way, but existing users still carry
 * the residue. Evict it (plus the orphaned `panel-run-parent-v2` key from
 * the v2→v3 autosaveId bump) once on load.
 */
function cleanupLegacyResizablePanelStorage() {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (
        key &&
        (key.startsWith("panel-group-react-aria") || key === "panel-run-parent-v2")
      ) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage may be disabled (private browsing, security policy)
  }
}
