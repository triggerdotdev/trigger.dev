// Recovers from a rolling deploy rotating the content-hashed /assets files out from
// under a page. Each image serves only its own build and hard-404s unknown hashes, so
// a client can request a hash the serving replica doesn't have and get missing styles
// or a failed asset load. On such an asset load failure we do a bounded full document
// reload: the fresh document (and, under sticky routing, all of its assets) lands on a
// single live build, so the asset resolves. Bounded via sessionStorage so it can never
// loop; when the budget is spent it stops rather than reloading forever.
//
// Deliberately minimal — no fetch interception, no build-version polling, no server
// build-id contract, no form snapshot, no blocking overlay.

// The recovery logic runs as an inline <script> injected before <Links /> (see the
// component below), so it must execute before the app bundle and before the stylesheet
// can fail to load. It is authored as a normal, type-checked and lint-checked function
// and serialized with .toString() at render time — NOT hand-written into a string — so
// the logic is real code the compiler and linter can see. Because it is serialized, it
// must stay fully self-contained: no imports, no references to module scope, and plain
// ES that the bundler won't rewrite to reach a hoisted helper. It returns its `recover`
// closure purely so the unit test can drive the logic directly (the inline IIFE that
// runs in the browser ignores the return value).
export function staleAssetRecoveryScript() {
  var KEY = "trigger:assetReload";
  var MAX_RELOADS = 2;
  var WINDOW_MS = 300000;
  var recovering = false;

  function budgetAllows() {
    try {
      var raw = sessionStorage.getItem(KEY);
      var state = raw ? (JSON.parse(raw) as { n: number; t: number }) : { n: 0, t: 0 };
      if (Date.now() - state.t > WINDOW_MS) state = { n: 0, t: 0 };
      if (state.n >= MAX_RELOADS) return false;
      sessionStorage.setItem(KEY, JSON.stringify({ n: state.n + 1, t: Date.now() }));
      return true;
    } catch {
      // Storage blocked (private mode / quota): can't bound reloads, so don't auto-reload.
      return false;
    }
  }

  function recover() {
    // One recovery per page: a broken load fails several hashed assets at once and each
    // fires its own error event before location.reload() commits — without this guard a
    // single incident would burn the entire reload budget.
    if (recovering) return;
    recovering = true;
    // Don't reload into the browser's offline error page.
    if (navigator.onLine === false) return;
    if (budgetAllows()) location.reload();
  }

  // Non-bubbling resource load failures (stylesheet, modulepreload, entry <script>) at
  // document load — the failure class nothing else covers. Capture phase is required.
  window.addEventListener(
    "error",
    function (event) {
      var el = event.target as Element | null;
      if (!el || typeof el.tagName !== "string") return; // window/global errors have no tagName
      var url =
        el.tagName === "LINK"
          ? (el as HTMLLinkElement).href
          : el.tagName === "SCRIPT"
            ? (el as HTMLScriptElement).src
            : null;
      // Match the pathname, not the full URL — a query string or third-party
      // URL containing /assets/ must not burn the reload budget.
      if (url && new URL(url, location.href).pathname.indexOf("/assets/") !== -1) recover();
    },
    true
  );

  // Raw dynamic import() failures in app code. (Remix reloads its own route chunks, so
  // that path rarely reaches here.) The message URL isn't reliable cross-browser, so
  // match the chunk-load error shape; the once-guard + bounded budget make a rare stray
  // reload harmless.
  window.addEventListener("unhandledrejection", function (event) {
    var message = (event.reason && event.reason.message) || "";
    if (
      /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(message)
    ) {
      recover();
    }
  });

  return { recover };
}

export function StaleAssetRecovery({ isProduction }: { isProduction: boolean }) {
  if (!isProduction) {
    return null;
  }

  return (
    <script dangerouslySetInnerHTML={{ __html: `(${staleAssetRecoveryScript.toString()})()` }} />
  );
}
