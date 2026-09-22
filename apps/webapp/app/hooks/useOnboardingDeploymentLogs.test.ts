// @vitest-environment jsdom
import { createS2Container } from "@internal/testcontainers/webapp";
import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { expect, it } from "vitest";
import { deploymentLogsCache } from "~/components/runs/v3/deploymentLogsCache";
import { useOnboardingDeploymentLogs } from "./useOnboardingDeploymentLogs";

it("recovers late terminal logs without reading or evicting legacy inspector cache entries", async () => {
  const server = await createS2Container();
  const client = new S2({
    accessToken: "local-test",
    endpoints: { account: `${server.endpoint}/v1`, basin: `${server.endpoint}/v1` },
    retry: { maxAttempts: 1 },
  });
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
    await client.basins.reconfigure({ basin: server.basin, createStreamOnRead: false });
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
    await server.container.stop();
  }
  expect(deploymentLogsCache.get(`${server.basin}/${stream}`)?.complete).toBe(true);
  expect(deploymentLogsCache.get(`onboarding:${server.basin}/${stream}`)).toBeUndefined();
}, 60_000);
