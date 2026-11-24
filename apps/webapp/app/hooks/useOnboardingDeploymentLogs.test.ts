// @vitest-environment jsdom
import { createS2Container, type StartedS2Container } from "@internal/testcontainers/webapp";
import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { deploymentLogsCache } from "~/components/runs/v3/deploymentLogsCache";
import { useOnboardingDeploymentLogs } from "./useOnboardingDeploymentLogs";

let server: StartedS2Container;
let client: S2;

beforeAll(async () => {
  server = await createS2Container();
  client = new S2({
    accessToken: "local-test",
    endpoints: { account: `${server.endpoint}/v1`, basin: `${server.endpoint}/v1` },
    retry: { maxAttempts: 1 },
  });
  await client.basins.reconfigure({ basin: server.basin, createStreamOnRead: false });
}, 120_000);

afterAll(async () => {
  await server?.container.stop();
}, 30_000);

it("recovers late terminal logs without reading or evicting legacy inspector cache entries", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const stream = `late-terminal-${Date.now()}`;
  let state: ReturnType<typeof useOnboardingDeploymentLogs> | undefined;
  function Probe() {
    const current = useOnboardingDeploymentLogs(
      {
        status: "FAILED",
        eventStream: { s2: { basin: server.basin, stream, accessToken: "local-test" } },
      },
      client
    );
    useEffect(() => {
      state = current;
    });
    return null;
  }
  async function until(check: () => void) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      try {
        check();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    }
  }
  try {
    // The legacy inspector can cache a missing terminal stream as complete.
    // Its cache entry must not suppress onboarding's late-stream recovery.
    deploymentLogsCache.set(`${server.basin}/${stream}`, {
      logs: [],
      nextSeqNum: 0,
      finalized: true,
      complete: true,
    });
    // Fill the legacy cache to capacity: an onboarding write must not evict it.
    for (let i = 0; i < 19; i++) {
      deploymentLogsCache.set(`legacy-${stream}-${i}`, {
        logs: [],
        nextSeqNum: 0,
        finalized: true,
        complete: true,
      });
    }
    await act(async () => {
      root.render(createElement(Probe));
    });
    await until(() => expect(state?.streamError).toContain("Reconnecting"));
    await client
      .basin(server.basin)
      .stream(stream)
      .append(
        AppendInput.create([
          AppendRecord.string({
            body: JSON.stringify({
              type: "log",
              data: { level: "error", message: "late failure diagnostic" },
            }),
          }),
          AppendRecord.string({
            body: JSON.stringify({ type: "finalized", data: { result: "failed" } }),
          }),
        ])
      );
    await until(() =>
      expect(state?.logs.map((log) => log.message)).toContain("late failure diagnostic")
    );
    expect(state?.streamError).toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
  expect(deploymentLogsCache.get(`${server.basin}/${stream}`)?.complete).toBe(true);
  expect(deploymentLogsCache.get(`onboarding:${server.basin}/${stream}`)).toBeUndefined();
}, 60_000);

it("keeps BuildKit's first-build registry cache miss in the logs without flagging it as an error", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const stream = `cache-miss-${Date.now()}`;
  let state: ReturnType<typeof useOnboardingDeploymentLogs> | undefined;
  function Probe() {
    const current = useOnboardingDeploymentLogs(
      {
        status: "DEPLOYED",
        eventStream: { s2: { basin: server.basin, stream, accessToken: "local-test" } },
      },
      client
    );
    useEffect(() => {
      state = current;
    });
    return null;
  }
  const log = (level: string, message: string) =>
    AppendRecord.string({ body: JSON.stringify({ type: "log", data: { level, message } }) });
  try {
    await client
      .basin(server.basin)
      .stream(stream)
      .append(
        AppendInput.create([
          log("info", "#11 importing cache manifest from registry.example.com/proj_abc:cache"),
          log(
            "error",
            "#11 ERROR: failed to configure registry cache importer: registry.example.com/proj_abc:cache: not found"
          ),
          log("error", "#12 ERROR: process did not complete successfully: exit code: 1"),
          AppendRecord.string({
            body: JSON.stringify({ type: "finalized", data: { result: "succeeded" } }),
          }),
        ])
      );
    await act(async () => {
      root.render(createElement(Probe));
    });
    const deadline = Date.now() + 10_000;
    // All records land in one append, so once the last one shows up the rest have too.
    while (!state?.logs.some((entry) => entry.message.startsWith("#12"))) {
      if (Date.now() >= deadline) throw new Error("logs never arrived");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    expect(state?.logs.map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: "info",
        message: "#11 importing cache manifest from registry.example.com/proj_abc:cache",
      },
      {
        level: "info",
        message:
          "#11 ERROR: failed to configure registry cache importer: registry.example.com/proj_abc:cache: not found",
      },
      { level: "error", message: "#12 ERROR: process did not complete successfully: exit code: 1" },
    ]);
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
}, 60_000);
