import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import { chatPostMessage, conversationsList } from "../actions/actions";

const authToken = () => process.env.SLACK_TOKEN ?? "";

describe("slack-example.actions", async () => {
  test("/conversations.list success", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("action.conversations.list");
    const data = await conversationsList.action({
      parameters: {
        limit: 3,
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
    stopNock(nockDone);
  });

  test("/chat.postMessage success with name", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("action.chat.postMessage.name");
    const data = await chatPostMessage.action({
      body: {
        channel: "test-integrations",
        text: "Using the channel name",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken,
        scopes: [
          "chat:write:user",
          "chat:write:bot",
          "conversations:read",
          "channels:write",
        ],
      },
    });

    expect(data.success).toEqual(true);
    expect(data.status).toEqual(200);
    expect(data.body.ok).toEqual(true);
    expect(data.body.message.text).toEqual("Using the channel name");
    stopNock(nockDone);
  });

  test("/chat.postMessage failed with bad name", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("action.chat.postMessage.badname");
    const data = await chatPostMessage.action({
      body: {
        channel: "this-channel-does-not-exist",
        text: "Using the channel name",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken,
        scopes: [
          "chat:write:user",
          "chat:write:bot",
          "conversations:read",
          "channels:write",
        ],
      },
    });

    expect(data.success).toEqual(false);
    expect(data.body.ok).toEqual(false);
    expect(data.body.error).toEqual("channel_not_found");
    stopNock(nockDone);
  });

  test("Get display properties", async () => {
    const displayProperties = await chatPostMessage.displayProperties({
      body: {
        channel: "my-channel",
        text: "Using the channel name",
      },
    });

    expect(displayProperties.title).toEqual("Post message to my-channel");
  });
});
