// @vitest-environment jsdom
import { createElement } from "react";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { expect, it } from "vitest";
import { OnboardingAutoRefresh } from "./OnboardingAutoRefresh";

it("refreshes onboarding and removes polling and focus refreshes when it unmounts", async () => {
  let enabled = false;
  let reads = 0;
  const router = createMemoryRouter([
    {
      path: "/",
      loader: () => {
        reads++;
        return { enabled };
      },
      Component: () => {
        const data = useLoaderData() as { enabled: boolean };
        return data.enabled ? createElement(OnboardingAutoRefresh, { interval: 20 }) : null;
      },
    },
  ]);
  const element = document.createElement("div");
  const root = createRoot(element);
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  };
  try {
    await act(async () => root.render(createElement(RouterProvider, { router })));
    await settle();
    const inactiveReads = reads;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(reads).toBe(inactiveReads);
    enabled = true;
    await act(async () => {
      await router.revalidate();
    });
    const enabledReads = reads;
    await settle();
    expect(reads).toBeGreaterThan(enabledReads);
    enabled = false;
    await act(async () => {
      await router.revalidate();
    });
    const stoppedReads = reads;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(reads).toBe(stoppedReads);
  } finally {
    await act(async () => root.unmount());
    router.dispose();
  }
});
