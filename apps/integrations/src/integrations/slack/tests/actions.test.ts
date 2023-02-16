import {
  describe,
  beforeEach,
  afterEach,
  expect,
  test,
  beforeAll,
  afterAll,
} from "vitest";
import nock from "nock";
import { chatPostMessage, conversationsList } from "../actions/actions";
import fs from "fs/promises";
import path from "path";

const authToken = () => process.env.SLACK_TOKEN ?? "";

const scriptName = path.basename(__filename);
const nockFile = `${__dirname}/nock/${scriptName}.json`;

describe("slack-example.actions", async () => {
  beforeAll(async () => {
    nock.cleanAll();
    try {
      nock.load(nockFile);
    } catch (e) {
      nock.recorder.clear();
      nock.recorder.rec({ output_objects: true, dont_print: true });
    }
  });

  afterAll(async (suite) => {
    if (suite.result?.errors?.length ?? 0 === 0) {
      const nockCalls = nock.recorder.play();
      nock.recorder.clear();

      if (nockCalls.length > 0) {
        await fs.mkdir(path.dirname(nockFile), { recursive: true });
        await fs.writeFile(nockFile, JSON.stringify(nockCalls, null, 2), {
          encoding: "utf-8",
        });
        console.log("Saved successful test result to nock", nockFile);
      }
    }
  });

  test("/conversations.list success", async () => {
    const accessToken = authToken();
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
  });

  test("/chat.postMessage success with name", async () => {
    const accessToken = authToken();

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
