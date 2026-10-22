import { alertRaisedSentence } from "emails/src/alertRaisedContent";
import { describe, expect, it } from "vitest";
import { buildAlertSlackMessage } from "./alertSlackMessage";

const input = {
  alertName: "Failed runs above 1 on sync-inventory",
  headline: "Failed runs above 1 on sync-inventory",
  project: "hello-world",
  environment: "Dev: You",
  raisedAt: "2026-10-15T11:40:12.000Z",
  dashboardLink: "https://cloud.trigger.dev/orgs/acme/projects/hw/env/dev/alerts/alert_1",
};

describe("buildAlertSlackMessage", () => {
  it("builds header, name, sentence and dashboard button", () => {
    const { text, blocks } = buildAlertSlackMessage(input);

    expect(text).toBe("Alert raised: Failed runs above 1 on sync-inventory");
    expect(blocks).toEqual([
      { type: "header", text: { type: "plain_text", text: "Alert raised" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Failed runs above 1 on sync-inventory*" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "The alert “Failed runs above 1 on sync-inventory” triggered for hello-world (Dev: You) at 2026-10-15 11:40 UTC.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open the dashboard" },
            url: input.dashboardLink,
          },
        ],
      },
    ]);
  });

  it("escapes mrkdwn control characters so mentions cannot ping", () => {
    const { text, blocks } = buildAlertSlackMessage({
      ...input,
      alertName: "<!channel> & co",
      headline: "<!here>",
      detail: "task: <@U123> & <!here>",
    });

    expect(text).toBe("Alert raised: &lt;!channel&gt; &amp; co");
    const json = JSON.stringify(blocks);
    expect(json).toContain("*&lt;!here&gt;*");
    expect(json).toContain("task: &lt;@U123&gt; &amp; &lt;!here&gt;");
    expect(json).toContain("&lt;!channel&gt; &amp; co");
    expect(json).not.toContain("<!here>");
    expect(json).not.toContain("<@U123>");
  });

  it("has no facts line", () => {
    const { blocks } = buildAlertSlackMessage(input);
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "section", "actions"]);
    expect(JSON.stringify(blocks)).not.toContain("Unit:");
  });

  it("uses the same sentence as the email", () => {
    const { blocks } = buildAlertSlackMessage(input);
    expect(blocks[2]).toMatchObject({ text: { text: alertRaisedSentence(input) } });
  });

  it("adds a detail section under the sentence only when detail is set", () => {
    const detail = "sync-inventory: Error: boom — New error group";
    const withDetail = buildAlertSlackMessage({ ...input, detail }).blocks;
    expect(withDetail[3]).toEqual({ type: "section", text: { type: "mrkdwn", text: detail } });
    expect(withDetail).toHaveLength(5);
    expect(buildAlertSlackMessage({ ...input, detail: null }).blocks).toHaveLength(4);
  });
});
