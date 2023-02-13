import { expect, test } from "vitest";
import { chatPostMessage, conversationsList } from "../actions/actions";

const authToken = () => process.env.SLACK_TOKEN ?? "";

test("/conversations.list success", async () => {
  const accessToken = authToken();
  expect(accessToken).not.toEqual("");
  try {
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
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});

test("/chat.postMessage success with name", async () => {
  const accessToken = authToken();
  expect(accessToken).not.toEqual("");

  try {
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
  } catch (e: any) {
    console.error(JSON.stringify(e, null, 2));
    expect(e).toEqual(null);
  }
});

test("/chat.postMessage failed with bad name", async () => {
  const accessToken = authToken();
  expect(accessToken).not.toEqual("");

  try {
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
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});
