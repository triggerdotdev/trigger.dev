// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyLoad, lazyWithRetry } from "~/components/primitives/LazyLoad";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

async function mount(load: () => Promise<{ default: () => JSX.Element }>) {
  const Lazy = lazyWithRetry(load);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      // The failed state's Reload button reads both providers.
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            LazyLoad,
            { fallback: "Loading" },
            createElement("p", null, "Around it"),
            createElement(Lazy)
          )
        )
      )
    );
  });
  return container;
}

const Editor = () => createElement("p", null, "The editor");

describe("LazyLoad", () => {
  // Catches: one failed fetch of an editor or panel (a tab left open across a deploy) replacing
  // the whole page with the route's error screen.
  it("keeps a load that fails twice inside its own part of the page", async () => {
    // React logs the caught error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module"))
    );

    const page = await mount(load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(page.textContent).toContain("Couldn't load this part of the page.");
    expect(page.querySelector("button")?.textContent).toBe("Reload");
  });

  it("renders the component when the second try works", async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Editor }>>()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValue({ default: Editor });

    const page = await mount(load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(page.textContent).toBe("Around itThe editor");
  });
});
