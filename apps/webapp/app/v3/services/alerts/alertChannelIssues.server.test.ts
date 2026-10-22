import { describe, expect, it } from "vitest";
import { alertChannelIssues, type NotifierChannel } from "./alertChannelIssues.server";

function channel(overrides: Partial<NotifierChannel>): NotifierChannel {
  return {
    id: "ch_1",
    name: "ops",
    enabled: true,
    type: "EMAIL",
    integrationId: null,
    environmentTypes: ["PRODUCTION"],
    ...overrides,
  };
}

function channels(...list: NotifierChannel[]) {
  return new Map(list.map((c) => [c.id, c]));
}

describe("alertChannelIssues", () => {
  it("reports nothing for a deliverable channel and ignores chat notifiers", () => {
    expect(
      alertChannelIssues(
        [{ type: "channel", channelId: "ch_1" }, { type: "chat" }],
        channels(channel({})),
        "PRODUCTION"
      )
    ).toEqual([]);
  });

  it("reports each undeliverable reason once per channel", () => {
    const issues = alertChannelIssues(
      [
        { type: "channel", channelId: "gone" },
        { type: "channel", channelId: "off" },
        { type: "channel", channelId: "env" },
        { type: "channel", channelId: "env" },
        { type: "channel", channelId: "slack" },
      ],
      channels(
        channel({ id: "off", name: "Off", enabled: false }),
        channel({ id: "env", name: "Staging only", environmentTypes: ["STAGING"] }),
        channel({ id: "slack", name: "Slack", type: "SLACK", integrationId: null })
      ),
      "PRODUCTION"
    );
    expect(issues).toEqual([
      { channelId: "gone", name: null, reason: "deleted" },
      { channelId: "off", name: "Off", reason: "disabled" },
      { channelId: "env", name: "Staging only", reason: "environment" },
      { channelId: "slack", name: "Slack", reason: "integration" },
    ]);
  });

  it("accepts a Slack channel with an integration", () => {
    expect(
      alertChannelIssues(
        [{ type: "channel", channelId: "ch_1" }],
        channels(channel({ type: "SLACK", integrationId: "int_1" })),
        "PRODUCTION"
      )
    ).toEqual([]);
  });
});
