import { describe, expect, it } from "vitest";
import {
  isLegacyAlertChannel,
  legacySubscriptions,
  toLegacyAlertChannelRows,
} from "./legacyAlertChannels";

const alertTypeTitle = (type: string) => type;

function channel(overrides: Partial<Parameters<typeof toLegacyAlertChannelRows>[0][number]>) {
  return {
    id: "channel_1",
    name: "On-call",
    type: "WEBHOOK" as const,
    enabled: true,
    alertTypes: [] as string[],
    environmentTypes: ["PRODUCTION"] as string[],
    ...overrides,
  } as Parameters<typeof toLegacyAlertChannelRows>[0][number];
}

describe("isLegacyAlertChannel", () => {
  it("is true for a TASK_RUN channel", () => {
    expect(isLegacyAlertChannel(["TASK_RUN"] as any)).toBe(true);
  });

  it("is true for TASK_RUN_ATTEMPT, DEPLOYMENT_FAILURE and DEPLOYMENT_SUCCESS", () => {
    expect(isLegacyAlertChannel(["TASK_RUN_ATTEMPT"] as any)).toBe(true);
    expect(isLegacyAlertChannel(["DEPLOYMENT_FAILURE"] as any)).toBe(true);
    expect(isLegacyAlertChannel(["DEPLOYMENT_SUCCESS"] as any)).toBe(true);
  });

  it("is false for an ERROR_GROUP-only channel", () => {
    expect(isLegacyAlertChannel(["ERROR_GROUP"] as any)).toBe(false);
  });

  it("is false for a DASHBOARD_AGENT_WATCH-only channel", () => {
    expect(isLegacyAlertChannel(["DASHBOARD_AGENT_WATCH"] as any)).toBe(false);
  });

  it("is false for a channel with no alert types", () => {
    expect(isLegacyAlertChannel([])).toBe(false);
    expect(toLegacyAlertChannelRows([channel({ alertTypes: [] })], alertTypeTitle)).toEqual([]);
  });
});

describe("toLegacyAlertChannelRows", () => {
  it("includes a TASK_RUN webhook and excludes an ERROR_GROUP channel", () => {
    const taskRunChannel = channel({ id: "c1", name: "Webhook", alertTypes: ["TASK_RUN"] });
    const errorGroupChannel = channel({
      id: "c2",
      name: "Error alert",
      alertTypes: ["ERROR_GROUP"],
    });

    const rows = toLegacyAlertChannelRows([taskRunChannel, errorGroupChannel], alertTypeTitle);

    expect(rows.map((r) => r.id)).toEqual(["c1"]);
  });

  it("labels the channel kind and its legacy alert types only", () => {
    const mixed = channel({
      id: "c3",
      type: "SLACK",
      alertTypes: ["TASK_RUN", "ERROR_GROUP"],
    });

    const [row] = toLegacyAlertChannelRows([mixed], alertTypeTitle);

    expect(row?.channelKind).toBe("Slack");
    expect(row?.alertTypeLabels).toEqual(["TASK_RUN"]);
  });
});

describe("legacySubscriptions", () => {
  it("returns one row per channel and alert type, replace first", () => {
    const [row] = toLegacyAlertChannelRows(
      [
        channel({
          alertTypes: ["DEPLOYMENT_FAILURE", "TASK_RUN"] as any,
          environmentTypes: ["PRODUCTION", "STAGING"] as any,
        }),
      ],
      alertTypeTitle
    );

    const rows = legacySubscriptions([row]);

    expect(rows.map((r) => [r.alertType, r.migration.kind])).toEqual([
      ["TASK_RUN", "replace"],
      ["DEPLOYMENT_FAILURE", "coming-soon"],
    ]);
    expect(rows[0].environmentNames).toEqual(["production", "staging"]);
  });

  it("labels rows by alert type even when the labels array is empty", () => {
    const rows = legacySubscriptions([
      {
        id: "c1",
        name: "On-call",
        channelKind: "Webhook",
        enabled: true,
        alertTypes: ["DEPLOYMENT_SUCCESS", "TASK_RUN"],
        alertTypeLabels: [],
        environmentNames: ["production"],
      },
    ]);

    expect(rows.map((r) => r.alertTypeLabel)).toEqual(["Task run failure", "Deployment success"]);
  });
});
