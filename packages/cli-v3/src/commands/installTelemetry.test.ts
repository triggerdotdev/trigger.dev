import { afterEach, describe, expect, it } from "vitest";
import type { AnalyticsSink } from "../utilities/productAnalytics.js";
import { OutroCommandError } from "../cli/common.js";
import { cancelInstall, installOutcomeFor, reportMcpInstalled } from "./installTelemetry.js";

const installed = [{ clientName: "cursor", scope: { scope: "user" } }];
const lookup = async () => ({ userId: "u1", apiUrl: "https://api.trigger.dev" });

async function report(input: Partial<Parameters<typeof reportMcpInstalled>[0]>) {
  const sent: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const sink: AnalyticsSink = {
    send: (_id, { event, properties }) => sent.push({ event, properties }),
    shutdown: async () => {},
  };
  await reportMcpInstalled({
    source: "init",
    results: installed,
    outcome: "success",
    sink,
    lookupUserId: lookup,
    ...input,
  });
  return sent;
}

afterEach(() => {
  delete process.env.TRIGGER_TELEMETRY_DISABLED;
});

describe("reportMcpInstalled", () => {
  it("reports an install with the entry point it came from", async () => {
    const sent = await report({});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: "mcp_installed",
      properties: { source: "init", clients: ["cursor"], scopes: ["user"], outcome: "success" },
    });
  });

  // Catches: reporting after the user opted out of the command's telemetry.
  it("sends nothing with skipTelemetry", async () => {
    expect(await report({ skipTelemetry: true })).toEqual([]);
  });

  // Catches: counting a declined or empty wizard as an install.
  it("sends nothing when nothing was installed", async () => {
    expect(await report({ results: [] })).toEqual([]);
  });

  // Catches: reporting an install aimed at a self-hosted server under the stored Cloud login.
  it("sends nothing for an explicit non-Cloud API URL, without any lookup", async () => {
    let lookups = 0;
    const sent = await report({
      apiUrl: "http://localhost:3030",
      lookupUserId: async () => (lookups++, undefined),
    });
    expect(sent).toEqual([]);
    expect(lookups).toBe(0);
  });

  // Catches: a user declining the wizard being counted as a failed install.
  it("sends nothing when the wizard is cancelled", async () => {
    expect(await report({ results: [], outcome: "cancelled" })).toEqual([]);
  });

  // Catches: looking the user up under the current profile instead of the command's own.
  it("looks the user up under the command's profile", async () => {
    const asked: Array<{ profile?: string; apiUrl?: string }> = [];
    await report({
      profile: "selfhosted",
      apiUrl: "https://api.trigger.dev",
      lookupUserId: async (o) => (asked.push(o), undefined),
    });
    expect(asked).toMatchObject([{ profile: "selfhosted", apiUrl: "https://api.trigger.dev" }]);
  });

  it("still reports a failed install", async () => {
    expect((await report({ results: [], outcome: "error" }))[0]?.properties.outcome).toBe("error");
  });
});

describe("installOutcomeFor", () => {
  // Catches: a real failure, like an unsupported scope, being hidden as a cancellation.
  it("treats only prompt cancellations as cancelled", () => {
    expect(installOutcomeFor(cancelInstall("No scope selected"))).toBe("cancelled");
    expect(installOutcomeFor(new OutroCommandError("does not support the scope"))).toBe("error");
    expect(installOutcomeFor(new Error("boom"))).toBe("error");
  });
});
