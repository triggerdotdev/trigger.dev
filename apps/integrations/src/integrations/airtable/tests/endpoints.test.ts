import { saveToNock, setupNock } from "testing/nock";
import { describe, beforeAll, afterAll, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
const authToken = () => process.env.AIRTABLE_TOKEN ?? "";

describe("airtable.endpoints", async () => {
  beforeAll(async () => {
    setupNock(__filename);
  });

  afterAll(async (suite) => {
    await saveToNock(__filename, suite);
  });

  test("listRecords simple", async () => {
    const accessToken = authToken();

    const data = await endpoints.listRecords.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
      },
      body: {},
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:read"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
  });

  test("getRecord", async () => {
    const accessToken = authToken();

    const data = await endpoints.getRecord.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
        recordId: "recHcnB1MbBr9Rd2P",
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:read"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.body).not.toBeNull();
  });
});
