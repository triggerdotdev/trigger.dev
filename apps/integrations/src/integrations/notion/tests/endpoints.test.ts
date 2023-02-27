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
        type: "oauth2",
        name: "oauth",
        accessToken,
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
        type: "oauth2",
        name: "oauth",
        accessToken,
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
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("getPage", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.getPage");
    const data = await endpoints.getPage.request({
      parameters: {
        "Notion-Version": notionVersion,
        page_id: "b4609033-b45a-4fc6-8d15-f06920495ab1",
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("createPage (page parent)", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.createPage.pageParent");
    const data = await endpoints.createPage.request({
      parameters: {
        "Notion-Version": notionVersion,
      },
      body: {
        parent: {
          type: "page_id",
          page_id: "b4609033-b45a-4fc6-8d15-f06920495ab1",
        },
        properties: {
          title: {
            title: [
              {
                type: "text",
                text: {
                  content: "Test page",
                },
              },
            ],
          },
        },
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("updatePage (page parent)", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.updatePage.pageParent");
    const data = await endpoints.updatePage.request({
      parameters: {
        page_id: "b4609033-b45a-4fc6-8d15-f06920495ab1",
        "Notion-Version": notionVersion,
      },
      body: {
        icon: {
          emoji: "🦸‍♀️",
        },
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("getBlock", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.getBlock");
    const data = await endpoints.getBlock.request({
      parameters: {
        block_id: "b4609033-b45a-4fc6-8d15-f06920495ab1",
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("getBlockChildren", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.getBlockChildren");
    const data = await endpoints.getBlockChildren.request({
      parameters: {
        block_id: "b4609033-b45a-4fc6-8d15-f06920495ab1",
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("updateBlock", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.updateBlock");
    const data = await endpoints.updateBlock.request({
      parameters: {
        block_id: "2675c67d-392a-4b86-86f6-93de22c797bd",
        "Notion-Version": notionVersion,
      },
      body: {
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content:
                  "This update comes from the Trigger.dev Notion integration test suite. 🎉",
              },
            },
          ],
        },
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("appendBlockChildren", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.appendBlockChildren");
    const data = await endpoints.appendBlockChildren.request({
      parameters: {
        block_id: "b4609033-b45a-4fc6-8d15-f06920495ab1",
        "Notion-Version": notionVersion,
      },
      body: {
        children: [
          {
            heading_1: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content:
                      "This new title is appended using appendBlockChildren()",
                  },
                },
              ],
            },
          },
        ],
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("deleteBlock", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.deleteBlock");
    const data = await endpoints.deleteBlock.request({
      parameters: {
        block_id: "4c946f30-ebc2-4eed-bfbc-094226ae9659",
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("search (only pages)", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.search.pages");
    const data = await endpoints.search.request({
      parameters: {
        "Notion-Version": notionVersion,
      },
      body: {
        query: "Notion test page",
        page_size: 1,
        filter: {
          property: "object",
          value: "page",
        },
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });
});
