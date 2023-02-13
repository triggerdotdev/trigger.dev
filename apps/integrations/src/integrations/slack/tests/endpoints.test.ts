import { expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
const authToken = () => process.env.SLACK_TOKEN ?? "";

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
  expect(accessToken).not.toEqual("");

  try {
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
  } catch (e: any) {
    console.error(JSON.stringify(e.errors, null, 2));
    expect(e).toEqual(null);
  }
});

test("/chat.postMessage bad channel", async () => {
  const accessToken = authToken();
  expect(accessToken).not.toEqual("");
  try {
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
  } catch (e: any) {
    console.error(JSON.stringify(e, null, 2));
    expect(e).toEqual(null);
  }
});

test("/conversations.list success", async () => {
  const accessToken = authToken();
  expect(accessToken).not.toEqual("");

  try {
    const data = await endpoints.conversationsList.request({
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
