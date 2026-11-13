// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";

function OpenDialog() {
  return createElement(
    "div",
    null,
    createElement("p", null, "Page behind the dialog"),
    createElement(
      Dialog,
      { open: true },
      createElement(
        DialogContent,
        null,
        createElement(DialogHeader, null, "New environment variables")
      )
    )
  );
}

// The server has no `document`, so the Radix portal renders nothing there. Rendering the server
// half in this jsdom environment needs `document` absent for that one call.
function renderOnServer() {
  vi.stubGlobal("document", undefined);
  try {
    return renderToString(createElement(OpenDialog));
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("Dialog", () => {
  // Catches: a dialog that is open on the first render (a route that is a dialog, loaded
  // directly) portalling during hydration, so React throws away the server HTML for the page.
  it("hydrates an initially open dialog without a mismatch, then shows it", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderOnServer();
    document.body.appendChild(container);

    const recoverableErrors: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, createElement(OpenDialog), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(recoverableErrors).toEqual([]);
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "New environment variables"
    );
  });
});
