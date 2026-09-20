// @vitest-environment jsdom
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { TranscriptDownloadButton } from "./TranscriptDownloadButton";

let server: Server | undefined;
let root: Root | undefined;
let container: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

async function serve(handler: (response: ServerResponse) => void) {
  server = createServer((_request, response) => handler(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}/resources/transcript-download`;
}

async function render(resourcePath: string, initiallyAvailable: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            "div",
            null,
            createElement("h1", null, "Session overview"),
            createElement(TranscriptDownloadButton, { resourcePath, initiallyAvailable })
          )
        )
      )
    )
  );
}

async function settleUntil(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

test("a seeded transcript uses a native attachment link without fetching the object", async () => {
  let requests = 0;
  const url = await serve((response) => {
    requests++;
    response.end();
  });
  await render(url, true);
  const link = container.querySelector<HTMLAnchorElement>('a[aria-label="Download transcript"]');
  expect(link?.href).toBe(url);
  expect(link?.hasAttribute("download")).toBe(true);
  expect(requests).toBe(0);
});

test("an HTML proxy error shows availability guidance and Retry recovers", async () => {
  let attempts = 0;
  const url = await serve((response) => {
    if (++attempts === 1) {
      response.writeHead(502, { "Content-Type": "text/html" });
      response.end("<html>Bad gateway</html>");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ available: true }));
    }
  });
  await render(url, false);
  await settleUntil(() => !!container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not check transcript availability."
  );
  expect(container.textContent).not.toContain("Unexpected token");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await settleUntil(() => !!container.querySelector("a[download]"));
  expect(attempts).toBe(2);
});

test("a pending availability request does not block the overview and a missing object stays hidden", async () => {
  let pending: ServerResponse | undefined;
  const url = await serve((response) => {
    pending = response;
  });
  await render(url, false);
  await settleUntil(() => !!pending);
  expect(container.querySelector("h1")?.textContent).toBe("Session overview");
  expect(container.querySelector("a")).toBeNull();
  await act(async () => {
    pending!.writeHead(200, { "Content-Type": "application/json" });
    pending!.end(JSON.stringify({ available: false }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.textContent).toBe("Session overview");
});
