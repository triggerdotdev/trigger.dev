import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
import { promises as fs } from "fs";
import { SearchResponse } from "../endpoints/schemas/search";
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

  //todo when we have a page id
  // test("getPage", async () => {
  //   const accessToken = authToken();

  //   // const nockDone = await startNock("notion.getPage");
  //   const data = await endpoints.getPage.request({
  //     parameters: {
  //       "Notion-Version": notionVersion,
  //       page_id: "9257302b-0758-480e-bef1-10889636f107",
  //     },
  //     credentials: {
  //       type: "api_key",
  //       name: "api_key",
  //       api_key: accessToken,
  //       scopes: [""],
  //     },
  //   });

  //   console.log(JSON.stringify(data, null, 2));

  //   expect(data.status).toEqual(200);
  //   expect(data.success).toEqual(true);
  //   expect(data.body).not.toBeNull();
  //   // stopNock(nockDone);
  // });

  test("search (only pages)", async () => {
    const accessToken = authToken();

    // const nockDone = await startNock("notion.search.pages");

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

    await fs.writeFile(
      `${__dirname}/search-schema.json`,
      JSON.stringify(SearchResponse, null, 2)
    );

    await fs.writeFile(
      `${__dirname}/search.json`,
      JSON.stringify(data, null, 2)
    );

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();

    // stopNock(nockDone);
  });
});
