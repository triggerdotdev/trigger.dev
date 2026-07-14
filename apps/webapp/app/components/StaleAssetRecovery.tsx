// Self-heals stale-deploy asset failures: when a /build asset 404s (the
// client holds HTML from a previous build), reload at most twice, 30s apart.
// Must render before <Links /> so the listener precedes the stylesheet.
const script = `(function () {
  var KEY = "trigger:assetReload";
  var MIN_INTERVAL = 30000;
  var RESET_AFTER = 300000;
  var MAX_ATTEMPTS = 2;
  var scheduled = false;
  function reload() {
    if (scheduled) return;
    try {
      var state = JSON.parse(sessionStorage.getItem(KEY) || "{}");
      var elapsed = Date.now() - (state.t || 0);
      var attempts = elapsed > RESET_AFTER ? 0 : state.n || 0;
      if (attempts >= MAX_ATTEMPTS) return;
      // Failures fire once, at page load — delay the retry instead of
      // dropping it, so an in-progress deploy gets time to finish.
      var wait = Math.max(0, MIN_INTERVAL - elapsed);
      sessionStorage.setItem(KEY, JSON.stringify({ t: Date.now() + wait, n: attempts + 1 }));
      scheduled = true;
      setTimeout(function () {
        location.reload();
      }, wait);
    } catch (e) {
      return;
    }
  }
  window.addEventListener(
    "error",
    function (event) {
      var el = event.target;
      if (!el || el === window) return;
      var url = el.tagName === "LINK" ? el.href : el.tagName === "SCRIPT" ? el.src : null;
      if (url && url.indexOf("/build/") !== -1) reload();
    },
    true
  );
  window.addEventListener("unhandledrejection", function (event) {
    var message = event.reason && event.reason.message;
    if (
      typeof message === "string" &&
      /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(message)
    ) {
      reload();
    }
  });
})();`;

export function StaleAssetRecovery({ isProduction }: { isProduction: boolean }) {
  if (!isProduction) {
    return null;
  }

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
