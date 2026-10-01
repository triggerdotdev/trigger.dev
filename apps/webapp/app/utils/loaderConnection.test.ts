// @vitest-environment jsdom
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JSDOM } from "jsdom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
  createMemoryRouter,
  RouterProvider,
  useLoaderData,
  useLocation,
  useNavigation,
} from "react-router-dom";
import { typedjson } from "remix-typedjson";
import { TaskRunsTable } from "../components/runs/v3/TaskRunsTable";
import type { NextRunListItem } from "../presenters/v3/NextRunListPresenter.server";
import { isRunsListLoading } from "../routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/shouldRevalidateRunsList";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DisconnectedBanner } from "../components/DisconnectedBanner";
import { OperatingSystemContextProvider } from "../components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "../components/primitives/ShortcutsProvider";
import { createLoaderFetch, isLoaderDisconnected } from "./loaderConnection";

declare const jsdom: JSDOM;

let disconnected = false;
let status = 200;
let reads = 0;
const server = createServer((request, response) => {
  reads++;
  if (disconnected && !request.url?.includes("healthy")) {
    request.socket.destroy();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ reads }));
});
let url: string;
const loaderFetch = createLoaderFetch(globalThis.fetch);

beforeEach(async () => {
  disconnected = false;
  status = 200;
  reads = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  jsdom.reconfigure({ url: origin });
  url = `${origin}/?_data=dashboard`;
  await loaderFetch(url);
  reads = 0;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for connection state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("keeps the mounted page and data during a failed refresh, then recovers", async () => {
  const router = createMemoryRouter([
    {
      path: "/",
      loader: async ({ request }) => {
        const response = await loaderFetch(url, { signal: request.signal });
        return response.json();
      },
      Component: () =>
        createElement(
          "div",
          null,
          createElement("p", null, `Loaded ${(useLoaderData() as { reads: number }).reads}`),
          createElement(DisconnectedBanner)
        ),
      errorElement: createElement("p", null, "Full-page error"),
    },
  ]);
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(ShortcutsProvider, null, createElement(RouterProvider, { router }))
        )
      );
      await waitUntil(() => router.state.initialized);
    });
    const page = element.querySelector("p");
    expect(page?.textContent).toBe("Loaded 1");

    disconnected = true;
    await act(async () => {
      router.revalidate();
      await waitUntil(isLoaderDisconnected);
    });
    expect(element.querySelector("p")).toBe(page);
    expect(page?.textContent).toBe("Loaded 1");
    expect(element.querySelector('[role="status"]')?.textContent).toContain("Connection lost");
    expect(element.textContent).not.toContain("Full-page error");

    disconnected = false;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await waitUntil(() => router.state.revalidation === "idle");
    });
    expect(element.querySelector("p")).toBe(page);
    expect(page?.textContent).toBe("Loaded 3");
    expect(element.querySelector('[role="status"]')).toBeNull();

    disconnected = true;
    await act(async () => {
      router.revalidate();
      await waitUntil(isLoaderDisconnected);
    });
    const refresh = element.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    expect(refresh).not.toBeNull();
    expect(refresh?.disabled).toBe(false);
    disconnected = false;
    await act(async () => {
      refresh?.click();
      await waitUntil(() => router.state.revalidation === "idle");
    });
    expect(element.querySelector("p")).toBe(page);
    expect(page?.textContent).toBe("Loaded 5");
    expect(element.querySelector('[role="status"]')).toBeNull();
  } finally {
    router.dispose();
    await act(async () => root.unmount());
  }
});

it.each([
  { name: "saved rows", empty: false, hasFilters: false, initial: "saved-task", next: "next-task" },
  {
    name: "unfiltered empty state",
    empty: true,
    hasFilters: false,
    initial: "No runs found",
    next: "No runs found",
  },
  {
    name: "filtered empty state",
    empty: true,
    hasFilters: true,
    initial: "There are no runs for saved-task",
    next: "There are no runs for next-task",
  },
])(
  "keeps $name visible during a disconnected pagination navigation",
  async ({ empty, hasFilters, initial, next }) => {
    const organization = { id: "org-test", slug: "test" };
    const project = { id: "project-test", slug: "test" };
    const environment = { id: "env-test", slug: "dev", type: "DEVELOPMENT" };
    const tableSearch = "?hide=ver,started,dur,machine,queue,test,created,delayed,ttl,tags";
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app.orgs.$organizationSlug",
          path: "/",
          loader: () =>
            typedjson({ organization, organizations: [organization], project, environment }),
          children: [
            {
              path: "runs",
              loader: async ({ request }) => {
                await loaderFetch(url, { signal: request.signal });
                return {
                  task: new URL(request.url).searchParams.has("cursor")
                    ? "next-task"
                    : "saved-task",
                };
              },
              Component: () => {
                const { task } = useLoaderData() as { task: string };
                const navigation = useNavigation();
                const location = useLocation();
                const run = {
                  id: "run-test",
                  friendlyId: "run_test",
                  spanId: "span-test",
                  environment,
                  taskIdentifier: task,
                  taskKind: "TASK",
                  status: "COMPLETED_SUCCESSFULLY",
                  hasFinished: true,
                  rootTaskRunId: null,
                  isCancellable: false,
                  isReplayable: false,
                } as NextRunListItem;
                return createElement(TaskRunsTable, {
                  total: empty ? 0 : 1,
                  hasFilters,
                  filters: { tasks: hasFilters ? [task] : [] } as React.ComponentProps<
                    typeof TaskRunsTable
                  >["filters"],
                  runs: empty ? [] : [run],
                  isLoading: isRunsListLoading(navigation, location.search),
                });
              },
            },
          ],
        },
      ],
      { initialEntries: [`/runs${tableSearch}`] }
    );
    const element = document.createElement("div");
    const root = createRoot(element);
    try {
      await act(async () => {
        root.render(
          createElement(
            OperatingSystemContextProvider,
            { platform: "mac" },
            createElement(ShortcutsProvider, null, createElement(RouterProvider, { router }))
          )
        );
        await waitUntil(() => router.state.initialized);
      });
      expect(element.textContent).toContain(initial);
      disconnected = true;
      await act(async () => {
        router.navigate(`/runs${tableSearch}&cursor=next`);
        await waitUntil(isLoaderDisconnected);
      });
      expect(router.state.navigation.state).toBe("loading");
      expect(element.textContent).toContain(initial);
      expect(element.textContent).not.toContain("Loading…");
      disconnected = false;
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await waitUntil(() => router.state.navigation.state === "idle");
      });
      expect(element.textContent).toContain(next);
      if (initial !== next) expect(element.textContent).not.toContain(initial);
    } finally {
      router.dispose();
      await act(async () => root.unmount());
    }
  }
);

it("does not retry writes or non-loader reads, and passes server errors through", async () => {
  disconnected = true;
  await expect(loaderFetch(url, { method: "POST" })).rejects.toThrow();
  await expect(loaderFetch(url.replace("?_data=dashboard", ""))).rejects.toThrow();
  expect(reads).toBe(2);
  expect(isLoaderDisconnected()).toBe(false);

  disconnected = false;
  status = 500;
  expect((await loaderFetch(url)).status).toBe(500);
  expect(reads).toBe(3);
});

it("retries even when the browser never reports going offline", async () => {
  disconnected = true;
  const pending = loaderFetch(url);
  await waitUntil(isLoaderDisconnected);
  expect(navigator.onLine).toBe(true);
  disconnected = false;
  expect((await pending).status).toBe(200);
  expect(isLoaderDisconnected()).toBe(false);
  expect(reads).toBe(2);
}, 10_000);

it("cancels a disconnected loader without retrying it after navigation", async () => {
  disconnected = true;
  const controller = new AbortController();
  const pending = loaderFetch(url, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await waitUntil(isLoaderDisconnected);
  controller.abort();
  await rejected;
  window.dispatchEvent(new Event("online"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads).toBe(1);
  expect(isLoaderDisconnected()).toBe(false);
});

it("keeps the banner until all failed reads recover or are canceled", async () => {
  disconnected = true;
  const canceled = new AbortController();
  const retrying = new AbortController();
  const first = loaderFetch(url, { signal: canceled.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const second = loaderFetch(url, { signal: retrying.signal });
  try {
    await waitUntil(() => reads === 2 && isLoaderDisconnected());
    expect((await loaderFetch(`${url}&healthy=1`)).status).toBe(200);
    expect(isLoaderDisconnected()).toBe(true);

    canceled.abort();
    await rejected;
    expect(isLoaderDisconnected()).toBe(true);

    disconnected = false;
    window.dispatchEvent(new Event("online"));
    expect((await second).status).toBe(200);
    expect(isLoaderDisconnected()).toBe(false);
  } finally {
    canceled.abort();
    retrying.abort();
    await Promise.allSettled([first, second]);
  }
});
