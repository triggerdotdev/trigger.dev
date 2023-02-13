import { expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";

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
  try {
    const data = await endpoints.chatPostMessage.request({
      body: {
        channel: "C04GWUTDC3W",
        text: "This the Trigger.dev integrations test",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken: "xoxb-276370297397-4578980839603-5mrIOR6E5KQGhOwtAYTaMC2x",
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
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});

test("/chat.postMessage bad channel", async () => {
  try {
    const data = await endpoints.chatPostMessage.request({
      body: {
        channel: "C00AAAAAAAA",
        text: "This channel doesn't exist, so message won't send",
      },
      credentials: {
        type: "oauth2",
        name: "slackAuth",
        accessToken: "xoxb-276370297397-4578980839603-5mrIOR6E5KQGhOwtAYTaMC2x",
        scopes: ["chat:write:user", "chat:write:bot"],
      },
    });

    expect(data.success).toEqual(false);
    expect(data.status).toEqual(200);
    expect(data.body.ok).toEqual(false);
    expect(data.body.error).toEqual("channel_not_found");
  } catch (e: any) {
    console.error(JSON.stringify(e, null, 2));
    expect(e).toEqual(null);
  }
});

test("/conversations.list success", async () => {
  try {
    const data = await endpoints.conversationsList.request({
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
