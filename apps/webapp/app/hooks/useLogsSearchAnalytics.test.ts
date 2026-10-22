// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router-dom";
import { expect, it } from "vitest";
import { LogsSearchAnalytics, logsSearchKey } from "../utils/logsSearchAnalytics";
import { useLogsSearchLifecycle } from "./useLogsSearchAnalytics";

const logsPath = "/orgs/example/projects/project/env/prod/logs";
const queryResult = {
  logs: [{ message: "never sent" }],
  filters: { from: new Date(0), to: new Date(3600_000) },
  searchProgress: {
    complete: true,
    timedOut: false,
    stopped: false,
    expired: false,
    queryElapsedMs: 10,
  },
};

async function mount(data: Promise<typeof queryResult>) {
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const analytics = new LogsSearchAnalytics((event, properties) =>
    events.push({ event, properties })
  );
  let releaseOtherPage!: () => void;
  const otherPage = new Promise<void>((resolve) => {
    releaseOtherPage = resolve;
  });

  function Page() {
    const { requestFilterState } = useLoaderData() as { requestFilterState: string };
    useLogsSearchLifecycle(analytics, data, requestFilterState);
    return null;
  }

  const router = createMemoryRouter(
    [
      {
        path: logsPath,
        loader: ({ request }) => {
          const url = new URL(request.url);
          return { requestFilterState: logsSearchKey(url.pathname, url.search) };
        },
        element: createElement(Page),
      },
      { path: "/other", loader: () => otherPage, element: null },
    ],
    { initialEntries: [logsPath] }
  );
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });
  return {
    analytics,
    events,
    router,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      releaseOtherPage();
      router.dispose();
    },
  };
}

it("keeps the search active across a BFCache restore without a React remount", async () => {
  const page = await mount(Promise.resolve(queryResult));
  try {
    expect(page.events.map(({ event }) => event)).toEqual([
      "logs_search_started",
      "logs_search_result",
    ]);
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    page.analytics.action("open_result");
    expect(page.events.at(-1)?.properties).toMatchObject({
      action: "open_result",
      search_id: page.events[0].properties.search_id,
    });
    expect(page.events[1].properties).toMatchObject({
      timing_origin: "route_mount",
      time_range_bucket: "up_to_1h",
    });
    expect(JSON.stringify(page.events)).not.toContain("never sent");
  } finally {
    await page.cleanup();
  }
});

it("does not cancel or restart a search for an interrupted navigation", async () => {
  let resolveQuery!: (result: typeof queryResult) => void;
  const data = new Promise<typeof queryResult>((resolve) => {
    resolveQuery = resolve;
  });
  const page = await mount(data);
  try {
    await act(async () => {
      void page.router.navigate("/other");
    });
    expect(page.events.map(({ event }) => event)).toEqual(["logs_search_started"]);
    await act(async () => {
      await page.router.navigate(logsPath);
    });
    expect(page.events.map(({ event }) => event)).toEqual(["logs_search_started"]);
    await act(async () => {
      resolveQuery(queryResult);
    });
    expect(page.events.map(({ event }) => event)).toEqual([
      "logs_search_started",
      "logs_search_result",
    ]);
    expect(page.events[1].properties.search_id).toBe(page.events[0].properties.search_id);
  } finally {
    await page.cleanup();
  }
});
