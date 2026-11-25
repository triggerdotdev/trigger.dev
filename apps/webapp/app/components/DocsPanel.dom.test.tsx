// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { TextLink } from "~/components/primitives/TextLink";
import { docsPath } from "~/utils/pathBuilder";
import { DocsHeaderButton, DocsPanel, useDocsLink } from "./DocsPanel";

const flags = vi.hoisted(() => ({ hasDocsPanel: false }));
vi.mock("~/hooks/useFeatureFlags", () => ({ useFeatureFlags: () => flags }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ externalRef: "proj_test" }) }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function BodyLink() {
  const docsLink = useDocsLink();
  return <TextLink {...docsLink("triggering#options")}>Read the docs</TextLink>;
}

const links = (
  <>
    <DocsHeaderButton path="/limits">Limits docs</DocsHeaderButton>
    <BodyLink />
  </>
);

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function render(element: ReactNode) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OperatingSystemContextProvider platform="mac">
          <ShortcutsProvider>{element}</ShortcutsProvider>
        </OperatingSystemContextProvider>
      ),
    },
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  const link = (text: string) =>
    Array.from(container.querySelectorAll("a")).find((a) => a.textContent?.includes(text));
  // Reports whether the dashboard took over the click; stops jsdom from navigating either way.
  const click = async (text: string, init: MouseEventInit = {}) => {
    let prevented = false;
    const record = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    window.addEventListener("click", record);
    await act(async () => {
      link(text)!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
      );
    });
    window.removeEventListener("click", record);
    return prevented;
  };
  const iframe = () => container.querySelector("iframe");
  return { link, click, iframe };
}

describe("docs links", () => {
  it("open the docs panel at the page when the flag is on", async () => {
    flags.hasDocsPanel = true;
    const page = await render(<DocsPanel docsOrigin="https://docs.test">{links}</DocsPanel>);

    expect(await page.click("Limits docs")).toBe(true);
    const src = new URL(page.iframe()!.src);
    expect(src.origin + src.pathname).toBe("https://docs.test/docs/embed/limits");
    expect(src.searchParams.get("project")).toBe("proj_test");
    // The header button hides once the panel shows docs; body links move the panel on.
    expect(page.link("Limits docs")).toBeUndefined();

    expect(await page.click("Read the docs")).toBe(true);
    expect(new URL(page.iframe()!.src).pathname).toBe("/docs/embed/triggering");
  });

  it("leave modified clicks to the browser when the flag is on", async () => {
    flags.hasDocsPanel = true;
    const page = await render(<DocsPanel docsOrigin="https://docs.test">{links}</DocsPanel>);

    expect(await page.click("Limits docs", { metaKey: true })).toBe(false);
    expect(page.iframe()).toBeNull();
    // Catches: a modified click opening a different docs site than the panel shows.
    expect(page.link("Limits docs")!.getAttribute("href")).toBe("https://docs.test/docs/limits");
  });

  it("stay new-tab links when the flag is off", async () => {
    flags.hasDocsPanel = false;
    const page = await render(<DocsPanel docsOrigin="https://docs.test">{links}</DocsPanel>);

    expect(page.link("Limits docs")!.getAttribute("href")).toBe(docsPath("/limits"));
    expect(page.link("Limits docs")!.getAttribute("target")).toBe("_blank");
    expect(await page.click("Limits docs")).toBe(false);
    expect(await page.click("Read the docs")).toBe(false);
    expect(page.iframe()).toBeNull();
  });

  it("stay new-tab links outside the panel", async () => {
    flags.hasDocsPanel = true;
    const page = await render(links);

    expect(page.link("Limits docs")!.getAttribute("href")).toBe(docsPath("/limits"));
    expect(page.link("Read the docs")!.getAttribute("href")).toBe(docsPath("triggering#options"));
    expect(await page.click("Limits docs")).toBe(false);
  });
});
