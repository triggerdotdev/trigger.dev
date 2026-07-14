// Self-heals stale-deploy asset failures. When a /build asset fails to load
// (the client holds HTML from a previous build), poll /build-version with
// backoff and reload only once the server actually reports a different build
// than the one this page was rendered with (window.__remixManifest.version,
// inlined by Remix into every document). If the versions never diverge (the
// asset failed for some other reason) or the reload budget is spent, show a
// manual-reload banner instead of leaving a dead page. Must render before
// <Links /> so the listener precedes the stylesheet.
const script = `(function () {
  var KEY = "trigger:assetRecovery";
  var MAX_RELOADS = 2;
  var RESET_AFTER = 300000;
  var CHECK_DELAYS = [0, 2000, 4000, 8000, 15000, 30000];
  var recovering = false;

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || "{}");
    } catch (e) {
      return null;
    }
  }

  function writeState(state) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  function showBanner() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", showBanner);
      return;
    }
    if (document.getElementById("stale-asset-banner")) return;
    var banner = document.createElement("div");
    banner.id = "stale-asset-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 16px;background:#121317;color:#d7d9dd;font:14px/1.4 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.4)";
    var text = document.createElement("span");
    text.textContent = "This page failed to load properly, possibly due to an update being deployed.";
    var button = document.createElement("button");
    button.textContent = "Reload";
    button.style.cssText =
      "border:0;border-radius:4px;padding:5px 14px;background:#6366f1;color:#fff;font:inherit;cursor:pointer";
    button.onclick = function () {
      location.reload();
    };
    banner.appendChild(text);
    banner.appendChild(button);
    document.body.appendChild(banner);
  }

  function reloadFor(serverVersion) {
    var state = readState();
    if (!state) return showBanner();
    if (Date.now() - (state.t || 0) > RESET_AFTER) state = {};
    // One reload per observed server version, MAX_RELOADS total: a page that
    // is still broken after reloading for this build shows the banner
    // instead of reloading again.
    if (state.v === serverVersion || (state.reloads || 0) >= MAX_RELOADS) return showBanner();
    if (!writeState({ v: serverVersion, reloads: (state.reloads || 0) + 1, t: Date.now() })) {
      return showBanner();
    }
    location.reload();
  }

  function check(attempt) {
    fetch("/build-version", { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var mine = window.__remixManifest && window.__remixManifest.version;
        if (data && data.version && mine && data.version !== mine) {
          reloadFor(data.version);
        } else {
          scheduleNext(attempt);
        }
      })
      .catch(function () {
        scheduleNext(attempt);
      });
  }

  function scheduleNext(attempt) {
    var next = attempt + 1;
    if (next >= CHECK_DELAYS.length) return showBanner();
    setTimeout(function () {
      check(next);
    }, CHECK_DELAYS[next]);
  }

  function recover() {
    if (recovering) return;
    recovering = true;
    // __remixManifest is set by an inline script near the end of body; wait
    // for the document to finish parsing before comparing versions.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        check(0);
      });
    } else {
      check(0);
    }
  }

  window.addEventListener(
    "error",
    function (event) {
      var el = event.target;
      if (!el || el === window) return;
      var url = el.tagName === "LINK" ? el.href : el.tagName === "SCRIPT" ? el.src : null;
      if (url && url.indexOf("/build/") !== -1) recover();
    },
    true
  );
  window.addEventListener("unhandledrejection", function (event) {
    var message = event.reason && event.reason.message;
    if (
      typeof message === "string" &&
      /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(message)
    ) {
      recover();
    }
  });
})();`;

export function StaleAssetRecovery({ isProduction }: { isProduction: boolean }) {
  if (!isProduction) {
    return null;
  }

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
