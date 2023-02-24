import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
const authToken = () => process.env.NOTION_API_KEY ?? "";

const notionVersion = "2022-06-28";

describe("notion.endpoints", async () => {
  test("getUser", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.getUser");
    const data = await endpoints.getUser.request({
      parameters: {
        user_id: "cc18a80a-973f-42c4-8fed-a055f8ae31f4",
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "api_key",
        name: "api_key",
        api_key: accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("listUsers (first page)", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.listUsers.firstPage");
    const data = await endpoints.listUsers.request({
      parameters: {
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "api_key",
        name: "api_key",
        api_key: accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("getBotInfo", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.getBotInfo");
    const data = await endpoints.getBotInfo.request({
      parameters: {
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "api_key",
        name: "api_key",
        api_key: accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });
});
