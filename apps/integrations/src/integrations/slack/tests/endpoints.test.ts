import { describe, beforeAll, afterAll, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
import { saveToNock, setupNock } from "testing/nock";
const authToken = () => process.env.SLACK_TOKEN ?? "";

describe("slack-example.endpoints", async () => {
  beforeAll(async () => {
    setupNock(__filename);
  });

  afterAll(async (suite) => {
    await saveToNock(__filename, suite);
  });

  test("missing credentials", async () => {
    try {
      await endpoints.chatPostMessage.request({
        body: {
          channel: "C04GWUTDC3W",
          text: "This the Trigger.dev integrations test",
        },
      });
    } catch (e: any) {
      expect(e.type).toEqual("missing_credentials");
    }
  });

  test("/chat.postMessage success", async () => {
    const accessToken = authToken();

    const data = await endpoints.chatPostMessage.request({
      body: {
        channel: "C04GWUTDC3W",
        text: "This the Trigger.dev integrations test",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken,
        scopes: ["chat:write:user", "chat:write:bot"],
      },
    });

    expect(data.success).toEqual(true);
    expect(data.status).toEqual(200);
    expect(data.body.ok).toEqual(true);
    expect(data.body.channel).toEqual("C04GWUTDC3W");
    expect(data.body.message.text).toEqual(
      "This the Trigger.dev integrations test"
    );
  });

  test("/chat.postMessage bad channel", async () => {
    const accessToken = authToken();

    const data = await endpoints.chatPostMessage.request({
      body: {
        channel: "C00AAAAAAAA",
        text: "This channel doesn't exist, so message won't send",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken,
        scopes: ["chat:write:user", "chat:write:bot"],
      },
    });

    expect(data.success).toEqual(false);
    expect(data.status).toEqual(200);
    expect(data.body.ok).toEqual(false);
    expect(data.body.error).toEqual("channel_not_found");
  });

  test("/conversations.list success", async () => {
    const accessToken = authToken();

    const data = await endpoints.conversationsList.request({
      parameters: {
        limit: 1,
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken,
        scopes: ["conversations:read"],
      },
    });

    expect(data.success).toEqual(true);
    expect(data.status).toEqual(200);
    expect(data.body.ok).toEqual(true);
  });
});
