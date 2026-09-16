import { describe, expect, it } from "vitest";
import {
  buildErrorGroupSlackMessage,
  type ErrorAlertPayload,
} from "./errorGroupSlackMessage.server";

const payload: ErrorAlertPayload = {
  channelId: "channel",
  projectId: "project",
  classification: "new_issue",
  error: {
    fingerprint: "fingerprint",
    environmentId: "environment",
    environmentSlug: "prod",
    environmentName: "<prod|fake>",
    taskIdentifier: "<!channel>",
    errorType: "Error & warning",
    errorMessage: "message",
    sampleStackTrace: "```\n<!channel>\n" + "x".repeat(4000),
    firstSeen: "0",
    lastSeen: "1700000000000",
    occurrenceCount: 3,
  },
};

describe("buildErrorGroupSlackMessage", () => {
  it("bounds untrusted text without interpreting it as Slack markup", () => {
    const message = buildErrorGroupSlackMessage(
      payload,
      "https://example.com/errors/1",
      "<project>"
    );
    const heading = message.blocks[0] as {
      text: { type: string; text: string };
    };
    const attachment = message.attachments[0] as {
      blocks: Array<{
        text?: { type: string; text: string };
        fields?: Array<{ type: string; text: string }>;
        elements?: Array<{ url: string }>;
      }>;
    };
    const error = attachment.blocks[0].text!;
    const fields = attachment.blocks[1].fields!;

    expect(message.text.length).toBeLessThanOrEqual(4000);
    expect(message.mrkdwn).toBe(false);
    expect(message.parse).toBe("none");
    expect(message.text).not.toContain("<!channel>");
    expect(message.text).toContain("&lt;!channel&gt;");
    expect(heading.text.type).toBe("plain_text");
    expect(heading.text.text.length).toBeLessThanOrEqual(3000);
    expect(error.type).toBe("plain_text");
    expect(error.text.length).toBe(3000);
    expect(error.text).toContain("<!channel>");
    expect(fields.slice(0, 4).every((field) => field.type === "plain_text")).toBe(true);
    expect(fields.slice(0, 3).every((field) => field.text.length <= 2000)).toBe(true);
  });

  it("keeps generated links and date formatting separate from untrusted fields", () => {
    const message = buildErrorGroupSlackMessage(payload, "https://example.com/errors/1", "project");
    const attachment = message.attachments[0] as {
      blocks: Array<{
        fields?: Array<{ type: string; text: string }>;
        elements?: Array<{ url: string }>;
      }>;
    };

    expect(attachment.blocks[1].fields?.[4].type).toBe("mrkdwn");
    expect(attachment.blocks[1].fields?.[4].text).toContain("<!date^");
    expect(attachment.blocks[2].elements?.[0].url).toBe("https://example.com/errors/1");
  });
});
