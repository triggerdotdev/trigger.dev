import { expect, test } from "vitest";
import { chatPostMessage, conversationsList } from "../actions/actions";

test("/conversations.list success", async () => {
  try {
    const data = await conversationsList.action({
      parameters: {
        limit: 3,
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken: "xoxb-276370297397-4578980839603-5mrIOR6E5KQGhOwtAYTaMC2x",
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
  try {
    const data = await chatPostMessage.action({
      body: {
        channel: "test-integrations",
        text: "Using the channel name",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken: "xoxb-276370297397-4578980839603-5mrIOR6E5KQGhOwtAYTaMC2x",
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
  try {
    const data = await chatPostMessage.action({
      body: {
        channel: "this-channel-does-not-exist",
        text: "Using the channel name",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken: "xoxb-276370297397-4578980839603-5mrIOR6E5KQGhOwtAYTaMC2x",
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
