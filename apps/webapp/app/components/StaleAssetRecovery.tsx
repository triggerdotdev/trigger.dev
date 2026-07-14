// Recovers from deploys rotating the content-hashed /build assets out from
// under a page. Policy:
//
// 1. A working page is never touched just because a new build exists. Remix
//    loader fetches (?_data=) are stamped with X-Build-Id by the server;
//    when a navigation reveals a different build, the navigation is turned
//    into a full document load — the user lands on the new build without
//    ever seeing an incompatible state.
// 2. Only real incompatibility (a /build stylesheet/script 404 or a failed
//    chunk import) triggers recovery: an overlay goes up immediately, the
//    script polls /build-version with backoff, and reloads once the server
//    reports a different build than the page was rendered with
//    (window.__remixManifest.version). If versions never diverge or the
//    reload budget (one per observed build, 2 total) is spent, the overlay
//    offers a manual reload instead of leaving a dead page.
// 3. Before a recovery reload, form fields and scroll position are
//    snapshotted to sessionStorage and restored (best-effort) after the
//    reload. history.state is deliberately not restored — the Remix router
//    owns it, and reviving a stale one can desync the router.
//
// Must render before <Links /> so the listener precedes the stylesheet.
const script = `(function () {
  var VKEY = "trigger:assetRecovery";
  var SKEY = "trigger:recoverySnapshot";
  var MAX_RELOADS = 2;
  var RESET_AFTER = 300000;
  var SNAPSHOT_TTL = 30000;
  var CHECK_DELAYS = [0, 2000, 4000, 8000, 15000, 30000];
  var recovering = false;
  var navigated = false;

  function ownVersion() {
    return window.__remixManifest && window.__remixManifest.version;
  }

  function readJson(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch (e) {
      return undefined;
    }
  }

  function writeJson(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- form + scroll snapshot ------------------------------------------

  function takeSnapshot() {
    var fields = [];
    var els = document.querySelectorAll("input, textarea, select");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "password" || type === "file" || type === "hidden") continue;
      fields.push({
        i: i,
        id: el.id || null,
        name: el.name || null,
        tag: el.tagName,
        value: el.value,
        checked: el.checked === true,
      });
    }
    writeJson(SKEY, {
      t: Date.now(),
      path: location.pathname,
      scrollY: window.scrollY,
      fields: fields,
    });
  }

  function setNativeValue(el, value) {
    // Go through the prototype setter so React's value tracking notices the
    // change when the input event fires.
    var proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement
        : el.tagName === "SELECT"
          ? window.HTMLSelectElement
          : window.HTMLInputElement;
    var descriptor = Object.getOwnPropertyDescriptor(proto.prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function restoreSnapshot() {
    var snapshot = readJson(SKEY);
    try {
      sessionStorage.removeItem(SKEY);
    } catch (e) {}
    if (!snapshot || snapshot.path !== location.pathname) return;
    if (Date.now() - (snapshot.t || 0) > SNAPSHOT_TTL) return;
    var els = document.querySelectorAll("input, textarea, select");
    for (var i = 0; i < snapshot.fields.length; i++) {
      var field = snapshot.fields[i];
      var el = (field.id && document.getElementById(field.id)) || els[field.i];
      if (!el || el.tagName !== field.tag || (el.name || null) !== field.name) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        // click() keeps React state in sync with the DOM
        if (el.checked !== field.checked) el.click();
      } else if (field.value != null && el.value !== field.value) {
        setNativeValue(el, field.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (snapshot.scrollY) window.scrollTo(0, snapshot.scrollY);
  }

  window.addEventListener("load", function () {
    setTimeout(restoreSnapshot, 100);
  });

  function doReload() {
    takeSnapshot();
    location.reload();
  }

  // ---- scenario 1: working page, navigation as the update point --------

  var origFetch = window.fetch;
  window.fetch = function (input) {
    var result = origFetch.apply(this, arguments);
    try {
      var url = typeof input === "string" ? input : input && input.url;
      if (url && url.indexOf("_data=") !== -1) {
        result.then(function (response) {
          var server = response.headers.get("X-Build-Id");
          var mine = ownVersion();
          if (server && mine && server !== mine && !navigated && !recovering) {
            navigated = true;
            var target = new URL(url, location.origin);
            target.searchParams.delete("_data");
            location.assign(target.toString());
          }
        }, function () {});
      }
    } catch (e) {}
    return result;
  };

  // ---- scenario 2: page is actually broken ------------------------------

  function showOverlay(final) {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", function () {
        showOverlay(final);
      });
      return;
    }
    // ASCII only: documents are served without an explicit charset, so
    // non-ASCII here can render as mojibake on a broken page.
    var text = final ? "This page failed to load properly. Please reload." : "Loading...";
    var existing = document.getElementById("stale-asset-overlay-text");
    if (existing) {
      existing.textContent = text;
      if (final) document.getElementById("stale-asset-overlay-button").style.display = "";
      return;
    }
    var overlay = document.createElement("div");
    overlay.id = "stale-asset-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;background:#121317;color:#d7d9dd;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:24px";
    var message = document.createElement("p");
    message.id = "stale-asset-overlay-text";
    message.textContent = text;
    var button = document.createElement("button");
    button.id = "stale-asset-overlay-button";
    button.textContent = "Reload";
    button.style.cssText =
      "border:0;border-radius:4px;padding:7px 18px;background:#6366f1;color:#fff;font:inherit;cursor:pointer" +
      (final ? "" : ";display:none");
    button.onclick = doReload;
    overlay.appendChild(message);
    overlay.appendChild(button);
    document.body.appendChild(overlay);
  }

  function reloadFor(serverVersion) {
    var state = readJson(VKEY);
    if (state === undefined) return showOverlay(true);
    state = state || {};
    if (Date.now() - (state.t || 0) > RESET_AFTER) state = {};
    // One reload per observed server version, MAX_RELOADS total: a page that
    // is still broken after reloading for this build gets the manual overlay
    // instead of reloading again.
    if (state.v === serverVersion || (state.reloads || 0) >= MAX_RELOADS) return showOverlay(true);
    if (!writeJson(VKEY, { v: serverVersion, reloads: (state.reloads || 0) + 1, t: Date.now() })) {
      return showOverlay(true);
    }
    doReload();
  }

  function check(attempt) {
    origFetch("/build-version", { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var mine = ownVersion();
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
    if (next >= CHECK_DELAYS.length) return showOverlay(true);
    setTimeout(function () {
      check(next);
    }, CHECK_DELAYS[next]);
  }

  function recover() {
    if (recovering) return;
    recovering = true;
    showOverlay(false);
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
